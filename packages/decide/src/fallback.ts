import type { CandidateCost, Constraints, ResidencyClass, TargetGeo } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// The deterministic fallback path. This is a first-class, fully-tested code
// path — it is what runs today (no TYPESAFE_API_KEY exists in this
// environment) and what the AI path collapses to whenever a confidence gate
// or the global floor is breached. It asks nothing of any model: every
// decision here is arithmetic or a lookup over data already in hand.
// ---------------------------------------------------------------------------

/**
 * Heuristic US-region detector used only by the deterministic "us-only"
 * residency check below. The catalog's compliance-flag vocabulary
 * (gdpr/pipeda/lgpd/popia/in-country-only — see packages/catalog) has no
 * explicit "us" flag, so this falls back to region-id sniffing across all
 * three providers' naming conventions: AWS/GCP prefix with "us-"
 * (us-east-1, us-central1), Azure suffixes with "us" (eastus, westus2).
 * The four patterns below are deliberately narrow (start-anchored "us-",
 * "us" immediately followed by a digit, "us" at the very end, or "-us-")
 * so they don't match incidental "us" substrings inside unrelated region
 * names (e.g. "australiaeast" contains "us" but not adjacent to a digit,
 * a hyphen, or the end of the string).
 */
export function isUsRegion(region: string): boolean {
  return /^us-/.test(region) || /us[0-9]/.test(region) || /us$/.test(region) || /-us-/.test(region);
}

/**
 * Deterministic residency check mirroring the intent of Stage A's
 * `residencyOk` noul question, but computed from data already in hand:
 *  - "none" / unset: always satisfied.
 *  - "eu-only": requires the catalog's "gdpr" compliance flag.
 *  - "in-country": requires the catalog's "in-country-only" compliance flag.
 *  - "us-only": requires the region id to match a recognized US-region pattern.
 */
export function residencySatisfied(
  residency: ResidencyClass | undefined,
  candidate: Pick<CandidateCost, "region" | "complianceFlags">,
): boolean {
  switch (residency) {
    case undefined:
    case "none":
      return true;
    case "eu-only":
      return candidate.complianceFlags.includes("gdpr");
    case "in-country":
      return candidate.complianceFlags.includes("in-country-only");
    case "us-only":
      return isUsRegion(candidate.region);
    default:
      return true;
  }
}

/**
 * Deterministic capacity check mirroring Stage A's `capacityOk` noul
 * question: without a live capacity/allocation API, a region's own GA status
 * (already computed by packages/catalog) is the best available proxy for
 * "the node family is generally available here, not capacity-waitlisted".
 */
export function capacitySatisfied(candidate: Pick<CandidateCost, "gaStatus">): boolean {
  return candidate.gaStatus === true;
}

/** Node-pool sizing tier ids, kept in sync with questions.ts's SIZING_OPTIONS keys. */
export type SizingTier = "sizing.xs" | "sizing.s" | "sizing.m" | "sizing.l" | "sizing.xl";

/**
 * Deterministic node-pool sizing tier, derived directly from the bin-packing
 * result (`nodesNeeded`) already computed by packages/cost. This is exactly
 * "the deterministic bin-packing result" the gates table names as the
 * fallback for a sub-threshold sizing-tier answer, and it is also what the
 * fully-deterministic path uses outright.
 */
export function deterministicSizingTier(nodesNeeded: number): SizingTier {
  if (nodesNeeded <= 2) return "sizing.xs";
  if (nodesNeeded <= 5) return "sizing.s";
  if (nodesNeeded <= 10) return "sizing.m";
  if (nodesNeeded <= 20) return "sizing.l";
  return "sizing.xl";
}

/** The registry's documented default modules, used whenever a Stage B module-selection gate isn't met. */
export const REGISTRY_DEFAULT_INGRESS = "ingress.public-alb";
export const REGISTRY_DEFAULT_AUTOSCALING = "autoscaling.cluster-autoscaler-conservative";

export interface DeterministicSelection {
  /** The chosen candidate, or null when no candidate passes every hard constraint. */
  chosen: CandidateCost | null;
  /** Human-readable explanation: what passed, what didn't, and why this one won. */
  reason: string;
}

/**
 * The default, live-executing decision path: deterministically pick the
 * cheapest candidate that passes every hard constraint (allowed providers,
 * residency, capacity, and budget, when set). No model call, no randomness.
 */
export function selectCheapestPassingGates(
  candidates: CandidateCost[],
  geo: Pick<TargetGeo, "residency">,
  constraints: Pick<Constraints, "allowedProviders" | "maxMonthlyUsd">,
): DeterministicSelection {
  const total = candidates.length;

  let pool = candidates;
  if (constraints.allowedProviders && constraints.allowedProviders.length > 0) {
    const allowed = constraints.allowedProviders;
    pool = pool.filter((c) => allowed.includes(c.provider));
  }
  const afterProviderFilter = pool.length;

  pool = pool.filter((c) => residencySatisfied(geo.residency, c));
  const afterResidencyFilter = pool.length;

  pool = pool.filter((c) => capacitySatisfied(c));
  const afterCapacityFilter = pool.length;

  if (constraints.maxMonthlyUsd !== undefined) {
    const budget = constraints.maxMonthlyUsd;
    const withinBudget = pool.filter((c) => c.monthlyUsd <= budget);
    if (withinBudget.length > 0) {
      pool = withinBudget;
    }
    // If nothing fits the budget, we deliberately keep the (residency+capacity
    // passing) pool rather than returning null outright — a plan that is over
    // budget but otherwise valid is more useful than no plan at all, and the
    // reason string says so explicitly.
  }

  if (pool.length === 0) {
    return {
      chosen: null,
      reason:
        `No candidate passes the hard constraints: ${total} candidate(s) total, ` +
        `${afterProviderFilter} after allowedProviders filter, ${afterResidencyFilter} after residency ` +
        `(${geo.residency ?? "none"}) filter, ${afterCapacityFilter} after capacity/GA filter.`,
    };
  }

  const sorted = [...pool].sort((a, b) => a.monthlyUsd - b.monthlyUsd);
  const chosen = sorted[0]!;
  const runnerUp = sorted[1];
  const overBudget = constraints.maxMonthlyUsd !== undefined && chosen.monthlyUsd > constraints.maxMonthlyUsd;

  const reason =
    `Deterministic fallback: chose ${chosen.provider}:${chosen.region} at $${chosen.monthlyUsd.toFixed(2)}/mo — ` +
    `cheapest of ${pool.length} candidate(s) passing allowedProviders/residency(${geo.residency ?? "none"})/capacity(GA) checks` +
    (overBudget ? ` (note: exceeds maxMonthlyUsd of $${constraints.maxMonthlyUsd}; no candidate fit the budget)` : "") +
    (runnerUp ? `; runner-up was ${runnerUp.provider}:${runnerUp.region} at $${runnerUp.monthlyUsd.toFixed(2)}/mo.` : ".");

  return { chosen, reason };
}
