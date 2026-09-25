import type { Arch, CandidateCost, Provider, RegionCandidate, WorkloadSpec } from "@geodeploy/core";
import { allCandidates } from "@geodeploy/catalog";
import type { RegionPriceGroup } from "@geodeploy/cost";
import { rankCandidates } from "@geodeploy/cost";
import { haversineDistanceKm, type LatLon } from "@geodeploy/geo";
import {
  aws,
  azure,
  FsCache,
  gcp,
  getAwsPriceQuote,
  getAzurePriceQuote,
  getGcpPriceQuote,
} from "@geodeploy/pricing";
type AwsOfferSource = aws.AwsOfferSource;
type AzureRetailPriceSource = azure.AzureRetailPriceSource;
type GcpBillingSource = gcp.GcpBillingSource;
const AZURE_VM_SPECS = azure.AZURE_VM_SPECS;
const GCP_MACHINE_TYPES = gcp.GCP_MACHINE_TYPES;
import { mapWithConcurrency } from "./concurrency.js";

// The SKU shortlists this CLI prices per provider/region. Azure and GCP reuse
// the pricing package's own vendored vcpu/mem/arch spec tables verbatim
// (there is no other authoritative SKU list for those two); AWS has no such
// vendored list (its own pricing data carries vcpu/mem/arch natively), so
// this is a small, real, hand-picked shortlist spanning x86_64 and arm64.
// Includes one 8vcpu/32GiB shape per architecture (m5.2xlarge / m6g.2xlarge):
// packages/cost applies a 10% node-headroom reduction before bin-packing, so a
// shortlist that topped out at 4vcpu/16GiB could never actually host a
// 4vcpu-16gb pod (3.6 usable vcpu < 4 requested) — confirmed live, this
// silently dropped every AWS (and, symmetrically, every GCP) candidate for
// exactly the shape used in this project's own example command.
export const AWS_SKU_SHORTLIST: readonly string[] = [
  "m5.large",
  "m5.xlarge",
  "m5.2xlarge",
  "m6g.large",
  "m6g.xlarge",
  "m6g.2xlarge",
  "c7g.large",
];
export const AZURE_SKU_SHORTLIST: readonly string[] = Object.keys(AZURE_VM_SPECS);
export const GCP_SKU_SHORTLIST: readonly string[] = Object.keys(GCP_MACHINE_TYPES);

// AWS's per-region bulk offer files are buffered wholesale (see
// packages/pricing/src/aws/client.ts's own comment: "hundreds of MB" for the
// EC2 file), so pricing many region candidates at once means many of those
// buffers resident in memory simultaneously. A high per-SKU concurrency is
// fine (repeat SKU fetches for the same region reuse one cached offer file —
// see buildDefaultPricingSources below, which is what actually makes that
// true), but the *candidate* (i.e. distinct-region) concurrency has to stay
// small or a full-catalog live run (36 regions) can exhaust the heap.
const DEFAULT_CANDIDATE_CONCURRENCY = 3;
const DEFAULT_FETCH_CONCURRENCY = 4;

export interface PricingSources {
  awsSource?: AwsOfferSource;
  azureSource?: AzureRetailPriceSource;
  gcpSource?: GcpBillingSource;
}

/**
 * One shared `FsCache` behind all three providers' live sources. This
 * matters far more than it looks: each provider's `getXPriceQuote` function
 * defaults to a *brand-new* source (and thus a brand-new, empty in-memory
 * cache) on every single call when no source is passed in. Since a `plan`/
 * `price` run fires off many quote calls — every SKU in the shortlist, for
 * every candidate region, for every geo — never sharing one instance meant
 * AWS's multi-hundred-MB EC2 offer file was being independently re-read and
 * re-`JSON.parse`d from disk on nearly every call (confirmed live: this
 * alone took several CPU-minutes on a two-geo request). Constructing this
 * once per CLI invocation and threading it through every geo/candidate/SKU
 * fetch is what makes the in-process memoization in `FsCache` actually work,
 * instead of a cache that's discarded before it can ever be reused.
 */
export function buildDefaultPricingSources(): Required<PricingSources> {
  const cache = new FsCache();
  return {
    awsSource: aws.createLiveAwsOfferSource({ cache }),
    azureSource: azure.createLiveAzureRetailPriceSource({ cache }),
    gcpSource: gcp.getDefaultGcpBillingSource({ cache }),
  };
}

export interface BuildPriceGroupsOptions {
  sources?: PricingSources;
  /** Called once per SKU quote fetch that fails, instead of crashing the whole plan. Defaults to a stderr warning. */
  onSkuWarning?: (message: string) => void;
  /** Max SKUs priced concurrently within one region candidate. Default 4. */
  fetchConcurrency?: number;
  /** Max region candidates priced concurrently. Default 3 — see the memory note above. */
  candidateConcurrency?: number;
}

function skuShortlistFor(provider: Provider): readonly string[] {
  switch (provider) {
    case "aws":
      return AWS_SKU_SHORTLIST;
    case "azure":
      return AZURE_SKU_SHORTLIST;
    case "gcp":
      return GCP_SKU_SHORTLIST;
  }
}

/** Filters the full catalog to the candidates this request/query is allowed to consider. */
export function candidatesForProviders(allowedProviders?: readonly Provider[]): RegionCandidate[] {
  const all = allCandidates();
  if (!allowedProviders || allowedProviders.length === 0) return all;
  const allowed = new Set(allowedProviders);
  return all.filter((c) => allowed.has(c.provider));
}

/**
 * Fetches every SKU-shortlist price quote for one region candidate, skipping
 * (with a warning) any individual SKU that fails rather than crashing the
 * whole plan/price run — e.g. a SKU genuinely unavailable in that region.
 */
async function fetchQuotesForCandidate(
  candidate: RegionCandidate,
  sources: PricingSources,
  onSkuWarning: (message: string) => void,
  fetchConcurrency: number,
) {
  const skus = skuShortlistFor(candidate.provider);

  return mapWithConcurrency(skus, fetchConcurrency, async (sku) => {
    try {
      switch (candidate.provider) {
        case "aws":
          return await getAwsPriceQuote(
            { region: candidate.region, instanceType: sku },
            sources.awsSource ? { source: sources.awsSource } : {},
          );
        case "azure":
          return await getAzurePriceQuote(
            { region: candidate.region, armSkuName: sku },
            sources.azureSource ? { source: sources.azureSource } : {},
          );
        case "gcp":
          return await getGcpPriceQuote(
            { region: candidate.region, machineType: sku },
            sources.gcpSource ? { source: sources.gcpSource } : {},
          );
      }
    } catch (err) {
      onSkuWarning(
        `warning: skipping ${candidate.provider}:${candidate.region} sku=${sku}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }).then((quotes) => quotes.filter((q): q is NonNullable<typeof q> => q !== undefined));
}

/** Builds one `RegionPriceGroup` per candidate, pricing every SKU in its provider's shortlist. */
export async function buildRegionPriceGroups(
  candidates: readonly RegionCandidate[],
  demandCentroid: LatLon,
  opts: BuildPriceGroupsOptions = {},
): Promise<RegionPriceGroup[]> {
  // Constructed once per call (not per candidate/SKU) so every fetch this
  // call makes shares one in-process cache — see buildDefaultPricingSources.
  const sources = opts.sources ?? buildDefaultPricingSources();
  const onSkuWarning = opts.onSkuWarning ?? ((msg) => process.stderr.write(msg + "\n"));
  const fetchConcurrency = opts.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const candidateConcurrency = opts.candidateConcurrency ?? DEFAULT_CANDIDATE_CONCURRENCY;

  return mapWithConcurrency(candidates, candidateConcurrency, async (candidate) => {
    const quotes = await fetchQuotesForCandidate(candidate, sources, onSkuWarning, fetchConcurrency);
    const group: RegionPriceGroup = {
      provider: candidate.provider,
      region: candidate.region,
      centroid: candidate.centroid,
      quotes,
      distanceKm: haversineDistanceKm(demandCentroid, candidate.centroid),
      azCount: candidate.azCount,
      gaStatus: candidate.gaStatus,
      complianceFlags: candidate.complianceFlags,
    };
    return group;
  });
}

/**
 * End-to-end: catalog -> live/fixture pricing -> ranked `CandidateCost[]` for
 * one demand geo. `allowedArches`, when given, hard-excludes any SKU whose
 * architecture the container image was never built for (see
 * `@geodeploy/cost`'s `platformsToArches`/`pickCheapestSku`) — pass it
 * whenever a real `image.platforms` is known (i.e. from `plan`, not the
 * ad-hoc `price` command, which has no image to check compatibility
 * against and so leaves architecture unfiltered, price-only, as before).
 */
export async function priceAndRankForGeo(
  demandCentroid: LatLon,
  workload: WorkloadSpec,
  allowedProviders: readonly Provider[] | undefined,
  opts: BuildPriceGroupsOptions = {},
  allowedArches?: readonly Arch[],
): Promise<CandidateCost[]> {
  const candidates = candidatesForProviders(allowedProviders);
  const groups = await buildRegionPriceGroups(candidates, demandCentroid, opts);
  return rankCandidates(workload, groups, undefined, allowedArches);
}
