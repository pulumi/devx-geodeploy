import type { ConfidenceGate } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// Confidence gate thresholds — PROJECT-PLAN.md §5.5, risk-scaled per decision
// because the blast radius differs by orders of magnitude between these
// actions (hard-rejecting a non-compliant region vs. picking a sizing tier).
// ---------------------------------------------------------------------------
export const GATE_THRESHOLDS = {
  /** residencyOk (noul) — never soft-fail a compliance constraint. */
  residencyOk: 0.95,
  /** Region selection for a brand-new cluster (no incumbent to fall back to). */
  newClusterRegionSelection: 0.9,
  /** Region selection when a stack already exists — inertia is cheaper than churn. */
  incumbentRegionSelection: 0.75,
  /** Stage B module selection (ingress posture, autoscaling posture). */
  moduleSelection: 0.85,
  /**
   * Resize/rebalance topology decision — two distinct thresholds, not one,
   * because "worth suggesting to a human" and "safe to auto-apply
   * unattended" are different risk questions once autonomous mode exists.
   * Placed between nodePoolSizing (0.6) and moduleSelection/
   * newClusterRegionSelection (0.85/0.9): resizing already-live traffic is
   * riskier than picking an unapplied sizing tier, but less
   * compliance-sensitive than choosing which region a brand-new cluster
   * lands in.
   */
  resizeTopologySuggest: 0.7,
  resizeTopologyAutoApply: 0.85,
  /** Node-pool sizing tier — lower blast radius, cheaper to correct later. */
  nodePoolSizing: 0.6,
  /** Global floor: any decision below this aborts the AI path entirely for the geo. */
  globalFloor: 0.5,
} as const;

export type GateName = keyof typeof GATE_THRESHOLDS;

/**
 * Build a `ConfidenceGate` record for a single decision.
 *
 * `label` is not part of the persisted record (the schema is intentionally
 * minimal — value/threshold/passed only) but is used to produce a clear
 * error message if the model/mock returns a value outside the valid [0,1]
 * probability range, which would indicate a parsing bug rather than a
 * legitimate low-confidence answer.
 */
export function applyGate(value: number, threshold: number, label: string): ConfidenceGate {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`applyGate(${label}): value ${value} is not a probability in [0,1]`);
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`applyGate(${label}): threshold ${threshold} is not in [0,1]`);
  }
  return { value, threshold, passed: value >= threshold };
}

/** True when `value` breaches the global floor and the AI path must abort for this geo. */
export function breachesGlobalFloor(value: number): boolean {
  return value < GATE_THRESHOLDS.globalFloor;
}

/** The region-selection gate threshold to use, depending on whether this geo already has a deployed stack. */
export function regionSelectionThreshold(isIncumbent: boolean): number {
  return isIncumbent ? GATE_THRESHOLDS.incumbentRegionSelection : GATE_THRESHOLDS.newClusterRegionSelection;
}
