import type { Arch } from "@geodeploy/core";
import type { AwsOfferFile, AwsPriceDimension, AwsProduct } from "./types.js";

export interface AwsComputeInstanceFacts {
  sku: string;
  vcpu: number;
  memGiB: number;
  arch: Arch;
  nodeUsdPerHour: number;
}

function onDemandPriceDimensions(offer: AwsOfferFile, sku: string): AwsPriceDimension[] {
  const termsForSku = offer.terms.OnDemand?.[sku];
  if (!termsForSku) return [];
  return Object.values(termsForSku).flatMap((term) => Object.values(term.priceDimensions));
}

/** The (single) on-demand hourly/unit rate for a SKU with exactly one price dimension. */
function singleOnDemandPrice(offer: AwsOfferFile, sku: string): number | undefined {
  const dims = onDemandPriceDimensions(offer, sku);
  const dim = dims[0];
  if (!dim?.pricePerUnit.USD) return undefined;
  return Number.parseFloat(dim.pricePerUnit.USD);
}

function parseMemGiB(memory: string | undefined): number | undefined {
  // Attribute looks like "8 GiB" (or occasionally "NA").
  const match = memory?.match(/^([\d.]+)\s*GiB$/);
  return match?.[1] ? Number.parseFloat(match[1]) : undefined;
}

// AWS's bulk price list does not carry an explicit "architecture" attribute
// on EC2 products; `physicalProcessor` does, and every Graviton-family
// processor's name contains "Graviton". Everything else on this cloud is
// x86_64 today. This is an explicit, testable rule, not a regex over the
// instance type name.
function inferArch(physicalProcessor: string | undefined): Arch {
  return physicalProcessor?.includes("Graviton") ? "arm64" : "x86_64";
}

export interface FindComputeInstanceParams {
  region: string;
  instanceType: string;
  operatingSystem?: string; // default "Linux"
}

/** Locates the standard on-demand, shared-tenancy, no-preinstalled-software Linux price for an instance type. */
export function findComputeInstance(
  offer: AwsOfferFile,
  params: FindComputeInstanceParams,
): AwsComputeInstanceFacts | undefined {
  const operatingSystem = params.operatingSystem ?? "Linux";
  for (const product of Object.values(offer.products)) {
    const a = product.attributes;
    if (
      product.productFamily === "Compute Instance" &&
      a["instanceType"] === params.instanceType &&
      a["regionCode"] === params.region &&
      a["operatingSystem"] === operatingSystem &&
      a["tenancy"] === "Shared" &&
      a["preInstalledSw"] === "NA" &&
      a["capacitystatus"] === "Used"
    ) {
      const vcpu = a["vcpu"] ? Number.parseFloat(a["vcpu"]) : undefined;
      const memGiB = parseMemGiB(a["memory"]);
      const nodeUsdPerHour = singleOnDemandPrice(offer, product.sku);
      if (vcpu === undefined || memGiB === undefined || nodeUsdPerHour === undefined) continue;
      return { sku: product.sku, vcpu, memGiB, arch: inferArch(a["physicalProcessor"]), nodeUsdPerHour };
    }
  }
  return undefined;
}

/** gp3 general-purpose EBS storage, the modern default volume type, priced per GiB-month. */
export function findBlockStorageUsdPerGiBMonth(offer: AwsOfferFile, region: string): number | undefined {
  for (const product of Object.values(offer.products)) {
    const a = product.attributes;
    if (product.productFamily === "Storage" && a["regionCode"] === region && a["volumeApiName"] === "gp3") {
      return singleOnDemandPrice(offer, product.sku);
    }
  }
  return undefined;
}

/** The flat, standard (non-Auto-Mode, non-Outposts) EKS cluster-hours control-plane fee. */
export function findEksControlPlaneUsdPerHour(offer: AwsOfferFile, region: string): number | undefined {
  for (const product of Object.values(offer.products)) {
    const a = product.attributes;
    if (
      a["regionCode"] === region &&
      a["locationType"] === "AWS Region" &&
      a["operation"] === "CreateOperation" &&
      a["tiertype"] === "HAStandard" &&
      a["usagetype"]?.endsWith("-Hours:perCluster")
    ) {
      return singleOnDemandPrice(offer, product.sku);
    }
  }
  return undefined;
}

/** Base-tier (first ~10TB/month) public internet egress rate, region of origin. */
export function findEgressUsdPerGiB(offer: AwsOfferFile, region: string): number | undefined {
  for (const product of Object.values(offer.products)) {
    const a = product.attributes;
    if (
      a["transferType"] === "AWS Outbound" &&
      a["toLocation"] === "External" &&
      a["fromRegionCode"] === region
    ) {
      const dims = onDemandPriceDimensions(offer, product.sku);
      const baseTier = dims.find((d) => d.beginRange === "0" && d.pricePerUnit.USD);
      if (baseTier?.pricePerUnit.USD) return Number.parseFloat(baseTier.pricePerUnit.USD);
    }
  }
  return undefined;
}

// AWS prefixes `usagetype` with a per-region code for every region except
// us-east-1 (e.g. "EUC1-LoadBalancerUsage" in eu-central-1, vs. bare
// "LoadBalancerUsage" in us-east-1) — confirmed against live data. A naive
// `endsWith("LoadBalancerUsage")` would also match the *other*, unwanted
// "<prefix>-TS-LoadBalancerUsage" product (a distinct, cheaper Trust Store
// fee that happens to share the same operation), so the prefix must be
// anchored to allow at most one hyphenated region-code segment.
const ALB_USAGE_TYPE = /^([A-Za-z0-9]+-)?LoadBalancerUsage$/;

/** Application Load Balancer per-hour usage fee (excludes LCU/data-processing charges). */
export function findLoadBalancerUsdPerHour(offer: AwsOfferFile, region: string): number | undefined {
  for (const product of Object.values(offer.products)) {
    const a = product.attributes;
    if (
      a["regionCode"] === region &&
      a["locationType"] === "AWS Region" &&
      a["operation"] === "LoadBalancing:Application" &&
      a["usagetype"] !== undefined &&
      ALB_USAGE_TYPE.test(a["usagetype"])
    ) {
      return singleOnDemandPrice(offer, product.sku);
    }
  }
  return undefined;
}

// Exported for tests that want to assert on raw product attributes directly.
export type { AwsProduct };
