import type { DeploymentPlan, RegionResizeAction, UtilizationSnapshot } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// The deterministic resize fallback path. Like fallback.ts's decideGeo
// counterpart, this is a first-class, fully-tested code path — it is what
// runs whenever TYPESAFE_API_KEY is absent, and what the AI resize path
// collapses to whenever a confidence gate or the global floor is breached.
// It asks nothing of any model: every decision here is arithmetic over
// utilization numbers already in hand.
// ---------------------------------------------------------------------------

export const RESIZE_HIGH_UTIL_THRESHOLD = 0.8;
export const RESIZE_LOW_UTIL_THRESHOLD = 0.3;

/**
 * Node-count delta multipliers. Reused both here and by resize-engine.ts's
 * live-path decomposition of a model-chosen scale-up/scale-down: the model
 * (or the utilization threshold, in fallback) decides WHICH region and WHICH
 * direction, but the exact node-count magnitude is deterministic bin-packing
 * arithmetic — mirroring how Stage B separates ingress/autoscaling *posture*
 * (asked) from node-pool *sizing tier* (deterministicSizingTier, computed in
 * fallback.ts) rather than asking the model to produce a raw number.
 */
export const SCALE_UP_MULTIPLIER = 1.5;
export const SCALE_DOWN_MULTIPLIER = 0.5;

export function scaledUpNodes(currentNodes: number): number {
  return Math.ceil(currentNodes * SCALE_UP_MULTIPLIER);
}

export function scaledDownNodes(currentNodes: number): number {
  return Math.max(1, Math.floor(currentNodes * SCALE_DOWN_MULTIPLIER));
}

/**
 * Deterministically decide a per-region resize action from observed
 * utilization alone. `cpuUtilPct > RESIZE_HIGH_UTIL_THRESHOLD` scales up,
 * `< RESIZE_LOW_UTIL_THRESHOLD` scales down, otherwise no change. A region
 * whose utilization query errored (or is simply absent from the snapshot)
 * always resolves to "no-change" — never resize blind off of data we don't
 * actually have.
 *
 * This NEVER proposes a shift-out/shift-in, unlike the AI path. Deciding a
 * cross-region shift requires judgment about coverage/latency tradeoffs
 * (is the destination geo even meant to serve the source's traffic? does
 * moving capacity there hurt the destination's own users' latency?) that a
 * code-only rule cannot safely make — this is qualitatively different from
 * `selectCheapestPassingGates`'s Stage-A fallback rule, where "cheapest
 * candidate that passes every hard constraint" is genuinely unambiguous.
 * Fallback here is deliberately the safe, code-only *subset* of what the AI
 * path can do: independently resizing a region that is clearly over- or
 * under-utilized is safe arithmetic; rebalancing capacity between two
 * regions is not.
 */
export function deterministicResizeActions(
  plan: DeploymentPlan,
  utilization: UtilizationSnapshot,
): RegionResizeAction[] {
  const utilByGeo = new Map(utilization.regions.map((u) => [u.geoId, u]));

  return plan.regions.map((region): RegionResizeAction => {
    const util = utilByGeo.get(region.geoId);

    if (!util || util.error !== undefined) {
      return { geoId: region.geoId, action: "no-change" };
    }
    if (util.cpuUtilPct > RESIZE_HIGH_UTIL_THRESHOLD) {
      return { geoId: region.geoId, action: "scale-up", newNodesNeeded: scaledUpNodes(region.nodesNeeded) };
    }
    if (util.cpuUtilPct < RESIZE_LOW_UTIL_THRESHOLD) {
      return { geoId: region.geoId, action: "scale-down", newNodesNeeded: scaledDownNodes(region.nodesNeeded) };
    }
    return { geoId: region.geoId, action: "no-change" };
  });
}
