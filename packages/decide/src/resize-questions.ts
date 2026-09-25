import { choice, noul, score } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { DeploymentPlan, RegionPlan, RegionUtilization, UtilizationSnapshot } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// Resize/rebalance decision — a single joint choice() over every possible
// topology action across all currently-deployed regions, plus a confidence
// score() and a disruption-risk noul(). This deliberately does NOT reuse
// composite.ts's 5-dimension weighted scoring (costFit/coverage/maturity/
// sprawlRisk/archConsistency) — that shape exists for comparing *unpriced
// candidate regions* at Stage A. Resize reasons over regions that are
// already deployed and already priced; the only open question is which
// single topology move (if any) the observed utilization justifies right
// now, which is exactly what one choice() captures.
// ---------------------------------------------------------------------------

/** Compact, JSON-safe summary of one region's plan + observed utilization, embedded into every choice option so the model reasons from real data. */
function regionSummary(
  regionPlan: RegionPlan,
  util: RegionUtilization | undefined,
): { readonly [key: string]: JsonValue } {
  return {
    geoId: regionPlan.geoId,
    provider: regionPlan.provider,
    region: regionPlan.region,
    sku: regionPlan.sku,
    nodesNeeded: regionPlan.nodesNeeded,
    cpuUtilPct: util ? Math.round(util.cpuUtilPct * 1000) / 1000 : null,
    nodeCount: util ? util.nodeCount : null,
    podCount: util ? util.podCount : null,
    utilizationError: util?.error ?? null,
  };
}

/**
 * Build the `choice()` option set: "no-change", one "scale-up:<geoId>" and
 * one "scale-down:<geoId>" per currently-deployed region, and one
 * "shift:<fromGeoId>-><toGeoId>" per ORDERED pair of regions (every region
 * can be a shift source or destination relative to every other — N regions
 * yields N*(N-1) shift options). With the realistic number of target geos
 * this app handles (a handful), no shortlist cap is needed, unlike Stage A's
 * shortlistCandidates.
 */
function buildTopologyOptions(
  plan: DeploymentPlan,
  utilByGeo: Map<string, RegionUtilization>,
): Record<string, { readonly [key: string]: JsonValue }> {
  const options: Record<string, { readonly [key: string]: JsonValue }> = {
    "no-change": {
      regions: plan.regions.map((r) => regionSummary(r, utilByGeo.get(r.geoId))),
    },
  };

  for (const region of plan.regions) {
    const summary = regionSummary(region, utilByGeo.get(region.geoId));
    options[`scale-up:${region.geoId}`] = { target: summary };
    options[`scale-down:${region.geoId}`] = { target: summary };
  }

  for (const from of plan.regions) {
    for (const to of plan.regions) {
      if (from.geoId === to.geoId) continue;
      options[`shift:${from.geoId}->${to.geoId}`] = {
        from: regionSummary(from, utilByGeo.get(from.geoId)),
        to: regionSummary(to, utilByGeo.get(to.geoId)),
      };
    }
  }

  return options;
}

// Ordered 10-level rubric, written as *situations* (per TypeSafe's guidance,
// mirroring COVERAGE_LEVELS/MATURITY_LEVELS in questions.ts), index 0 =
// worst-supported recommendation, index 9 = best-supported. This scores how
// well the *observed utilization data itself* supports the chosen topology
// action — not the action's magnitude, which is always computed in code.
export const RESIZE_CONFIDENCE_LEVELS = [
  "Utilization data is missing or errored for most regions in the deployment, so the recommended action cannot be meaningfully justified from what remains",
  "Utilization data is missing or errored for at least one region, and the remaining regions' readings conflict with each other about which way pressure is trending",
  "All regions reported utilization, but readings are highly volatile, making a single point-in-time recommendation unreliable",
  "All regions reported utilization with only mild volatility, but the recommended action sits within a few points of a threshold boundary (around 80% or 30% CPU utilization)",
  "All regions reported utilization cleanly, but the affected region's node count is very small (1-2 nodes), so a single node's workload noise can swing its utilization percentage substantially",
  "All regions reported utilization cleanly with moderate node counts, and the recommended action is comfortably clear of any threshold boundary",
  "All regions reported utilization cleanly, the recommendation is comfortably clear of any threshold boundary, and the same direction of pressure has persisted across more than one observation",
  "All regions reported clean, stable utilization, the recommendation is unambiguous, and no other region in the deployment is a plausible closer call",
  "All regions reported clean, stable utilization, the recommendation is unambiguous, node counts are large enough that per-pod noise is negligible, and — if a shift — the source and destination form a clearly complementary pair",
  "All regions reported clean, stable, multi-observation-consistent utilization; the recommendation is unambiguous and comfortably clear of every threshold boundary, and — if a shift — the source would remain comfortably provisioned after moving capacity",
] as const;

/**
 * Build the fan-out question set for the resize/rebalance decision:
 *  - `topology`: the single joint action to take across the deployment.
 *  - `confidence`: how well the observed data supports that action.
 *  - `riskOfDisruption`: NOTE the field name names the *concern*, but per
 *    the noul() convention this repo already uses for residencyOk/
 *    capacityOk (true = the good outcome), `true` here means "safe to
 *    proceed / LOW risk", not "risk is present". This lets the engine gate
 *    it with the exact same `breachesGlobalFloor`/`applyGate` pattern
 *    Stage A applies to residencyOk/capacityOk (a low value is the bad
 *    outcome that should abort the AI path), instead of inverting the
 *    comparison for this one question.
 */
export function buildResizeQuestions(plan: DeploymentPlan, utilization: UtilizationSnapshot) {
  const utilByGeo = new Map(utilization.regions.map((u) => [u.geoId, u]));
  const options = buildTopologyOptions(plan, utilByGeo);

  return {
    topology: choice(
      "Given each currently-deployed region's observed CPU utilization, which single topology action should be taken across this deployment right now: leave everything as-is, scale one region up or down, or shift capacity from one region to another?",
      options,
    ),

    confidence: score(
      "How well does the observed utilization data across all regions support this topology recommendation?",
      RESIZE_CONFIDENCE_LEVELS,
    ),

    riskOfDisruption: noul(
      "Is applying this topology change right now unlikely to cause meaningful service disruption (i.e. is proceeding LOW risk)?",
      {
        true: "The action only adds capacity (scale-up), or removes capacity from a region with clear headroom (scale-down leaves utilization comfortably under the high-utilization threshold and at least one node running), or — for a shift — the destination already has a healthy running deployment and the source would retain at least one node with utilization comfortably below any threshold after the move.",
        false: "The action removes capacity from a region whose utilization is not clearly low (borderline or already elevated), scales a region down to a node count that could plausibly drop below the workload's minimum viable replica placement, or — for a shift — would leave the source under-provisioned or move capacity into a destination with no prior healthy deployment to validate against.",
      },
    ),
  };
}
