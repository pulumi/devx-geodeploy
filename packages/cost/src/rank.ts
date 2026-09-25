import type { Arch, CandidateCost, Centroid, PriceQuote, Provider, WorkloadSpec } from "@geodeploy/core";
import { NODE_HEADROOM_FACTOR } from "./tco.js";
import { pickCheapestSku } from "./binpack.js";

/**
 * Everything cost/rank needs about one provider/region, beyond raw pricing,
 * to produce a CandidateCost. This is deliberately a superset of
 * `RegionCandidate` (packages/core) plus the price quotes for that region —
 * callers typically build one of these per RegionCandidate by attaching the
 * matching slice of a provider/region-keyed PriceQuote[] map. The shape here
 * is this package's own input contract (not fixed by @geodeploy/core); the
 * fixed contract is the CandidateCost[] this module returns.
 */
export interface RegionPriceGroup {
  provider: Provider;
  region: string;
  /** This region's real location — passed straight through to the CandidateCost this group produces (e.g. for the web GUI's globe). */
  centroid: Centroid;
  /** Every SKU (both arches) available/priced in this provider/region. */
  quotes: readonly PriceQuote[];
  /** Distance in km from this region to the demand geo being served (from packages/geo). */
  distanceKm: number;
  azCount: number;
  gaStatus: boolean;
  complianceFlags?: readonly string[];
  /**
   * Whether this provider/region is known-provisionable independent of cost
   * (e.g. from packages/detect's provider readiness check). Cost has no way
   * to determine this on its own, so it defaults to `true` — "provisionable
   * until proven otherwise" — and callers that have readiness data should
   * pass it through explicitly.
   */
  provisionable?: boolean;
}

/**
 * Ranks provider/region candidates by monthly cost, ascending.
 *
 * For each group, the cheapest SKU that satisfies the workload's pod request
 * is chosen via `pickCheapestSku`, optionally restricted to `allowedArches`
 * (derive from a real image's built platforms with `platformsToArches` in
 * arch.ts — a node whose architecture the image was never built for is a
 * hard incompatibility, not a price tie-breaker); groups where no SKU can
 * host the workload at all (including because every available SKU is an
 * incompatible architecture) are dropped rather than included with a
 * nonsensical cost. The result is a flat `CandidateCost[]`, sorted so index
 * 0 is the cheapest viable provider/region — this exact array shape is the
 * fixed contract consumed by packages/decide.
 */
export function rankCandidates(
  workload: WorkloadSpec,
  groups: readonly RegionPriceGroup[],
  headroomFactor: number = NODE_HEADROOM_FACTOR,
  allowedArches?: readonly Arch[],
): CandidateCost[] {
  const candidates: CandidateCost[] = [];

  for (const group of groups) {
    const picked = pickCheapestSku(workload, group.quotes, headroomFactor, allowedArches);
    if (!picked) continue;

    candidates.push({
      provider: group.provider,
      region: group.region,
      sku: picked.quote.sku,
      arch: picked.quote.arch,
      centroid: group.centroid,
      nodesNeeded: picked.nodesNeeded,
      monthlyUsd: picked.monthlyUsd,
      breakdown: picked.breakdown,
      distanceKm: group.distanceKm,
      azCount: group.azCount,
      gaStatus: group.gaStatus,
      complianceFlags: [...(group.complianceFlags ?? [])],
      realism: picked.quote.realism,
      provisionable: group.provisionable ?? true,
    });
  }

  candidates.sort((a, b) => a.monthlyUsd - b.monthlyUsd);
  return candidates;
}
