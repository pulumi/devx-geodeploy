import type { CandidateCost, Provider, WorkloadSpec } from "@geodeploy/core";
import { knownGeoIds, normalizeGeo } from "@geodeploy/geo";
import { renderPriceTable } from "@geodeploy/report";
import { type BuildPriceGroupsOptions, priceAndRankForGeo } from "./pricingPipeline.js";
import { parseShape } from "./shape.js";

export interface RunPriceOptions {
  geoId: string;
  shape: string;
  allowedProviders?: Provider[];
  pricing?: BuildPriceGroupsOptions;
}

export interface RunPriceResult {
  candidates: CandidateCost[];
  table: string;
}

function adHocWorkload(shape: { vcpu: number; memGiB: number }): WorkloadSpec {
  return {
    manifests: ["<ad-hoc price query — no real manifest>"],
    replicasPerRegion: 1,
    requestsPerPod: { vcpu: shape.vcpu, memGiB: shape.memGiB },
    egressGiBPerMonth: 0,
    storageGiB: 0,
  };
}

export async function runPrice(opts: RunPriceOptions): Promise<RunPriceResult> {
  const canonical = normalizeGeo(opts.geoId);
  if (!canonical) {
    throw new Error(`Unknown --geo "${opts.geoId}". Known geo ids: ${knownGeoIds().join(", ")}.`);
  }

  const shape = parseShape(opts.shape);
  const workload = adHocWorkload(shape);

  const candidates = await priceAndRankForGeo(canonical.centroid, workload, opts.allowedProviders, opts.pricing);

  return { candidates, table: renderPriceTable(candidates) };
}
