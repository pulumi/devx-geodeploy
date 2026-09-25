// ---------------------------------------------------------------------------
// Composite scoring — computed in code, never sent to the model. TypeSafe
// scores coverage/costFit/maturity/sprawlRisk/archConsistency independently
// against situational rubrics; we normalize and weight them here so the
// ranking can be re-tuned (different profile, different weights) without
// another API call. See PROJECT-PLAN.md §5.5 and the delta plan's note that
// sprawlRisk stays a genuine scored dimension. archConsistency (added
// alongside cost/coverage/maturity — Docker/build requirements' contribution
// to the decision matrix) reflects that, among architecture-*compatible*
// candidates (incompatible ones are hard-filtered before this stage — see
// @geodeploy/cost's platformsToArches), keeping a multi-region deployment on
// as few distinct node architectures as practical is a genuine, if soft,
// operational-consistency preference, not something arithmetic can decide.
// ---------------------------------------------------------------------------

/** Every Stage A score() question in questions.ts uses a 10-level rubric (indices 0-9). */
export const SCORE_MAX_INDEX = 9;

/** Normalize a raw TypeSafe score (0..maxIndex, may be fractional) to 0..1, clamped. */
export function norm(value: number, maxIndex: number = SCORE_MAX_INDEX): number {
  if (maxIndex <= 0) throw new Error(`norm: maxIndex must be positive, got ${maxIndex}`);
  const n = value / maxIndex;
  return Math.min(1, Math.max(0, n));
}

export interface CompositeWeights {
  /** Weight on normalized costFit (higher costFit = more favorable price). */
  cost: number;
  /** Weight on normalized coverage (proximity/AZ redundancy for the demand geo). */
  coverage: number;
  /** Weight on normalized maturity (production-readiness of the region). */
  maturity: number;
  /** Weight on normalized sprawlRisk — SUBTRACTED, not added. */
  sprawl: number;
  /** Weight on normalized archConsistency (lower cross-region architecture heterogeneity = higher score). */
  archConsistency: number;
}

export interface CompositeInputs {
  costFit: number;
  coverage: number;
  maturity: number;
  sprawlRisk: number;
  archConsistency: number;
}

export type WeightProfileName = "latency-optimized" | "balanced" | "residency-first" | "failure-domain";

/**
 * Named weight presets. Each profile's five weights (cost, coverage,
 * maturity, sprawl, archConsistency) sum to 1.0 so they're comparable as
 * "how much this dimension matters"; `sprawl`'s weight is still applied
 * with a minus sign in `composite()` — it is a *penalty* weight, not a
 * bonus weight. `archConsistency` was carved out of the other four weights
 * (not appended on top) when it was added, so each profile's existing
 * character (which dimension dominates) is preserved, just slightly
 * diluted — see the per-profile notes below for the exact rationale.
 *
 *  - "latency-optimized" (DEFAULT, per the delta plan): coverage dominates —
 *    the whole point of GeoDeploy is placing compute near demand, so
 *    proximity/AZ-redundancy outweighs raw price and architecture
 *    consistency alike. cost .13 / coverage .48 / maturity .17 / sprawl .10
 *    / archConsistency .12.
 *  - "balanced": no dimension dominates; a modest, even-handed sprawl
 *    penalty, and architecture consistency weighted close to maturity since
 *    neither is this profile's defining concern. cost .25 / coverage .25 /
 *    maturity .20 / sprawl .12 / archConsistency .18.
 *  - "residency-first": residency itself is enforced as a hard noul gate
 *    elsewhere (candidates that fail it are rejected before composite
 *    scoring ever runs), so this profile's job is to pick, among the
 *    already-compliant survivors, the safest one to operate: maturity
 *    (production-readiness/AZ count, a proxy for a compliant region staying
 *    reliably compliant) weighted highest, sprawl penalized hardest (every
 *    additional provider multiplies the compliance/audit surface), and
 *    archConsistency weighted moderately — fewer active node architectures
 *    is also fewer things to keep in an audit's scope. cost .12 /
 *    coverage .12 / maturity .38 / sprawl .23 / archConsistency .15.
 *  - "failure-domain": optimizes for resilience via independent failure
 *    domains — maturity (AZ count / GA track record, i.e. structural
 *    robustness) dominates, sprawl is *deliberately* under-penalized because
 *    spreading across providers is the explicit goal here (not a cost to be
 *    minimized), and archConsistency is a minor consideration — architecture
 *    diversity isn't itself a failure-domain axis. cost .08 / coverage .17 /
 *    maturity .48 / sprawl .15 / archConsistency .12.
 */
export const WEIGHT_PROFILES: Record<WeightProfileName, CompositeWeights> = {
  "latency-optimized": { cost: 0.13, coverage: 0.48, maturity: 0.17, sprawl: 0.1, archConsistency: 0.12 },
  balanced: { cost: 0.25, coverage: 0.25, maturity: 0.2, sprawl: 0.12, archConsistency: 0.18 },
  "residency-first": { cost: 0.12, coverage: 0.12, maturity: 0.38, sprawl: 0.23, archConsistency: 0.15 },
  "failure-domain": { cost: 0.08, coverage: 0.17, maturity: 0.48, sprawl: 0.15, archConsistency: 0.12 },
};

export const DEFAULT_WEIGHT_PROFILE: WeightProfileName = "latency-optimized";

/**
 * composite = W.cost*norm(costFit) + W.coverage*norm(coverage) +
 *             W.maturity*norm(maturity) + W.archConsistency*norm(archConsistency) -
 *             W.sprawl*norm(sprawlRisk)
 */
export function composite(inputs: CompositeInputs, weights: CompositeWeights, maxIndex: number = SCORE_MAX_INDEX): number {
  return (
    weights.cost * norm(inputs.costFit, maxIndex) +
    weights.coverage * norm(inputs.coverage, maxIndex) +
    weights.maturity * norm(inputs.maturity, maxIndex) +
    weights.archConsistency * norm(inputs.archConsistency, maxIndex) -
    weights.sprawl * norm(inputs.sprawlRisk, maxIndex)
  );
}

export function resolveWeights(profile: WeightProfileName = DEFAULT_WEIGHT_PROFILE): CompositeWeights {
  const weights = WEIGHT_PROFILES[profile];
  if (!weights) throw new Error(`unknown weight profile: ${profile}`);
  return weights;
}
