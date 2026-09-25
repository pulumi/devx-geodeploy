import { choice, noul, score } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { CandidateCost } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// Stage A — provider+region joint selection (PROJECT-PLAN.md §5.5)
// ---------------------------------------------------------------------------

/** Compound candidate id, e.g. "aws:us-east-1". Matches the shape used across the plan/delta docs. */
export function candidateId(c: Pick<CandidateCost, "provider" | "region">): string {
  return `${c.provider}:${c.region}`;
}

/**
 * Shortlist rule (documented, deterministic): TypeSafe's `choice()` caps at
 * 255 options; we cap far below that, at 40. Within each provider present in
 * `candidates`, sort ascending by `monthlyUsd` and keep the cheapest
 * `ceil(40 / providerCount)` candidates for that provider (so no single
 * provider can crowd out the others). Concatenate those per-provider
 * shortlists, re-sort the union ascending by `monthlyUsd`, and hard-cap the
 * result at 40 total entries.
 */
export function shortlistCandidates(candidates: CandidateCost[], cap = 40): CandidateCost[] {
  const byProvider = new Map<string, CandidateCost[]>();
  for (const c of candidates) {
    const list = byProvider.get(c.provider) ?? [];
    list.push(c);
    byProvider.set(c.provider, list);
  }
  const providerCount = Math.max(1, byProvider.size);
  const perProvider = Math.max(1, Math.ceil(cap / providerCount));

  const shortlisted: CandidateCost[] = [];
  for (const list of byProvider.values()) {
    const sorted = [...list].sort((a, b) => a.monthlyUsd - b.monthlyUsd);
    shortlisted.push(...sorted.slice(0, perProvider));
  }

  shortlisted.sort((a, b) => a.monthlyUsd - b.monthlyUsd);
  return shortlisted.slice(0, cap);
}

/** Build the `choice()` criteria map for a shortlisted candidate set: id -> a description of that candidate. */
function candidateOptions(shortlisted: CandidateCost[]): Record<string, { readonly [key: string]: JsonValue }> {
  const options: Record<string, { readonly [key: string]: JsonValue }> = {};
  for (const c of shortlisted) {
    options[candidateId(c)] = {
      provider: c.provider,
      region: c.region,
      monthlyUsd: c.monthlyUsd,
      distanceKm: Math.round(c.distanceKm),
      azCount: c.azCount,
      gaStatus: c.gaStatus,
      complianceFlags: c.complianceFlags,
      nodesNeeded: c.nodesNeeded,
    };
  }
  return options;
}

// Ordered 2-10 level rubrics, written as *situations* per TypeSafe's guidance
// ("describe situations, not degrees"), index 0 = worst, index 9 = best
// (worst-to-best for coverage/costFit/maturity; for sprawlRisk index 9 is
// worst i.e. highest burden, since it is subtracted in composite scoring).

export const COVERAGE_LEVELS = [
  "Serves users on a different continent with no nearby presence and no submarine-cable-optimized path",
  "Serves users on a different continent but along a well-connected backbone route",
  "Same hemisphere, different continent, several thousand km away",
  "Same continent, a distant sub-region (e.g. opposite coast)",
  "Same continent, a moderately distant sub-region with typical cross-region latency",
  "Same sub-region, a neighboring country",
  "Same sub-region, an adjacent country with a direct low-latency path",
  "In-geo (same country/metro cluster) with a single availability zone",
  "In-geo with multiple availability zones and standard redundancy",
  "In-geo with multiple availability zones, directly in or adjacent to the demand geo's primary population center",
] as const;

export const COST_LEVELS = [
  "More than 3x the cost of the cheapest viable alternative for this workload",
  "Between 2x and 3x the cheapest alternative's cost",
  "Between 1.75x and 2x the cheapest alternative's cost",
  "Between 1.5x and 1.75x the cheapest alternative's cost",
  "Between 1.3x and 1.5x the cheapest alternative's cost",
  "Between 1.15x and 1.3x the cheapest alternative's cost",
  "Between 1.05x and 1.15x the cheapest alternative's cost",
  "Within 5% of the cheapest alternative's cost",
  "Tied for cheapest among all viable alternatives",
  "Strictly the cheapest viable alternative, with meaningful margin over the next cheapest",
] as const;

export const MATURITY_LEVELS = [
  "Region is not GA for the managed Kubernetes service and has no availability-zone redundancy",
  "Region is not GA (preview/limited access) but has multiple availability zones",
  "Region is GA for the managed Kubernetes service but has only a single availability zone",
  "Region is GA with two availability zones and a recent GA date (less than 6 months)",
  "Region is GA with two availability zones and an established track record (6-18 months GA)",
  "Region is GA with three availability zones and a recent GA date",
  "Region is GA with three availability zones and an established track record",
  "Region is GA with three-plus availability zones, an established track record, and full managed node-group feature parity with the provider's flagship regions",
  "Region is one of the provider's flagship/original regions with full feature parity and long-standing production usage",
  "Region is a flagship region with full feature parity and is the provider's documented default/recommended region for new production workloads",
] as const;

// Docker/build-aware dimension: candidates are already hard-filtered by
// architecture compatibility before they ever reach here (see
// @geodeploy/cost's platformsToArches/pickCheapestSku — a candidate whose
// only SKU is an architecture the image was never built for is excluded
// outright, not scored down). What remains a genuine judgment call, among
// architecture-*compatible* candidates, is whether picking this one keeps
// the deployment's set of active node architectures small: a multi-arch
// image can run correctly on either architecture per region, but a
// production fleet that ends up spread across both arm64 and x86_64 nodes
// carries real, if soft, operational cost (twice the node-type-specific
// runbooks, twice the perf-tuning baselines, twice the images to keep warm
// in each region's node cache) that a purely per-region cost/coverage
// comparison would never see. Worst (index 0) to best (index 9).
export const ARCH_CONSISTENCY_LEVELS = [
  "This candidate's architecture differs from every region already committed to in this deployment, and three or more regions are already committed",
  "This candidate's architecture differs from every region already committed to in this deployment, and one or two regions are already committed",
  "This candidate's architecture differs from most, but not all, regions already committed to",
  "This candidate's architecture differs from roughly half of the regions already committed to",
  "This candidate's architecture matches roughly half of the regions already committed to",
  "This candidate's architecture matches most, but not all, regions already committed to",
  "This candidate's architecture matches every region already committed to, out of two or more decided so far",
  "This candidate's architecture matches the single region already committed to so far",
  "No regions have been committed to yet in this deployment, or the image was only ever built for one architecture, so this pick cannot introduce any architecture inconsistency",
  "This candidate's architecture matches every region already committed to, and the image's build platforms include more than one architecture — this deployment stays on a single architecture in production despite having the flexibility to mix",
] as const;

export const SPRAWL_LEVELS = [
  "Provider is already used elsewhere in this deployment plan; no new credentials, tooling, or on-call runbooks are introduced",
  "Provider is already used elsewhere in this deployment plan; only a new region needs onboarding, not a new provider",
  "Provider is new to this plan but the organization already has production experience and tooling for it from other projects",
  "Provider is new to this plan but shares most tooling (IaC modules, observability, IAM patterns) with an already-used provider",
  "Provider is new to this plan and requires a distinct but well-documented set of tooling and credentials",
  "Provider is new to this plan and requires a distinct set of tooling, credentials, and on-call familiarity with no existing overlap",
  "Provider is new to this plan and would bring the total number of distinct providers in the deployment to its configured maximum",
  "Provider is new to this plan, would exceed typical team familiarity, and requires new compliance/audit scope",
  "Provider is new to this plan, requires new compliance/audit scope, and has no existing organizational relationship (billing, support contract) in place",
  "Provider is new to this plan, has no existing organizational relationship, requires new compliance/audit scope, and would push the deployment past its configured maximum provider count",
] as const;

export interface StageAState {
  demandGeo: unknown;
  candidates: unknown;
  constraints: unknown;
  /** Docker/build facts the archConsistency question is scored against — see engine.ts's decideGeoLive. */
  image: unknown;
}

/** Build the fan-out question set for Stage A. `shortlisted` must already be capped (see `shortlistCandidates`). */
export function buildStageAQuestions(shortlisted: CandidateCost[]) {
  const options = candidateOptions(shortlisted);
  return {
    selection: choice("Which candidate region should serve this demand geo?", options),

    coverage: score("How well does the selected region cover this demand geo's users?", COVERAGE_LEVELS),
    costFit: score(
      "How favorable is this candidate's monthly cost relative to the cheapest alternative in the shortlist?",
      COST_LEVELS,
    ),
    maturity: score(
      "How operationally mature is this region for production managed Kubernetes?",
      MATURITY_LEVELS,
    ),
    sprawlRisk: score(
      "How much operational burden does adding this candidate's provider to the deployment mix create?",
      SPRAWL_LEVELS,
    ),
    archConsistency: score(
      "Among architecture-compatible candidates (already filtered for the image's built platforms), how much cross-region node-architecture heterogeneity does selecting this one introduce to the deployment?",
      ARCH_CONSISTENCY_LEVELS,
    ),

    residencyOk: noul("Does the selected region satisfy the stated data-residency constraint for this demand geo?", {
      true: "The region's jurisdiction and compliance flags fully satisfy the demand geo's residency class (e.g. an eu-only demand geo mapped to an EU-jurisdiction region with a matching gdpr compliance flag).",
      false:
        "The region's jurisdiction or compliance flags do not fully satisfy the stated residency class, or residency cannot be confirmed from the given compliance flags.",
    }),
    capacityOk: noul("Is the required node family generally available (not capacity- or allocation-constrained) in this region?", {
      true: "The region is GA for the managed Kubernetes service and the requested node family is available without a capacity/allocation waitlist.",
      false: "The region is not GA, or the requested node family is known to be capacity-constrained or allocation-limited in this region.",
    }),

    fallback: choice(
      "If the top-ranked candidate becomes unavailable at apply time, which candidate is the best substitute?",
      options,
    ),
  };
}

// ---------------------------------------------------------------------------
// Stage B — module selection. Cluster/registry are a plain provider lookup
// (see engine.ts's PROVIDER_TO_MODULES) and are NEVER asked here: once the
// provider is fixed there is exactly one legal answer, and asking anyway
// would manufacture false confidence over a non-decision. TypeSafe choice()
// is reserved for the genuinely open categories below.
// ---------------------------------------------------------------------------

export const INGRESS_OPTIONS = {
  "ingress.public-alb":
    "Standard internet-facing load balancer with normal TLS termination and no additional edge filtering; suitable for public APIs with no unusual abuse exposure.",
  "ingress.waf-fronted":
    "Internet-facing ingress fronted by a web application firewall; suitable when the workload is public-facing, accepts untrusted user input, or has had prior abuse/security exposure.",
  "ingress.internal-only":
    "Private ingress with no public entry point; suitable for internal services, batch backends, or workloads reachable only via VPN/peering.",
} as const;

export const AUTOSCALING_OPTIONS = {
  "autoscaling.cluster-autoscaler-conservative":
    "Reactive scaling with slow scale-down (long cooldowns), prioritizing stability over cost; suitable for latency-sensitive or bursty-but-sparse traffic where node thrashing is costly.",
  "autoscaling.cluster-autoscaler-aggressive":
    "Reactive scaling tuned for fast scale-up and fast scale-down, prioritizing cost efficiency; suitable for steady, predictable traffic where node churn is cheap.",
  "autoscaling.karpenter-bin-packing":
    "Just-in-time node provisioning that bin-packs pods onto the smallest number of right-sized nodes; suitable for heterogeneous pod shapes where minimizing wasted capacity matters most.",
} as const;

export const SIZING_OPTIONS = {
  "sizing.xs": "Workload needs at most 2 nodes to satisfy replica count and per-pod resource requests",
  "sizing.s": "Workload needs 3 to 5 nodes to satisfy replica count and per-pod resource requests",
  "sizing.m": "Workload needs 6 to 10 nodes to satisfy replica count and per-pod resource requests",
  "sizing.l": "Workload needs 11 to 20 nodes to satisfy replica count and per-pod resource requests",
  "sizing.xl": "Workload needs more than 20 nodes to satisfy replica count and per-pod resource requests",
} as const;

/** Build the Stage B fan-out question set (ingress posture, autoscaling posture, node-pool sizing tier only). */
export function buildStageBQuestions() {
  return {
    ingress: choice("Which ingress posture should front this workload in the chosen region?", INGRESS_OPTIONS),
    autoscaling: choice(
      "Which autoscaling posture should manage node capacity for this workload in the chosen region?",
      AUTOSCALING_OPTIONS,
    ),
    sizing: choice(
      "Which node-pool sizing tier fits this workload's computed node requirement?",
      SIZING_OPTIONS,
    ),
  };
}
