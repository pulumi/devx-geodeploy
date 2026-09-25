import { TypeSafeClient, APIError, APIConnectionError, AuthenticationError } from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";
import type {
  Arch,
  CandidateCost,
  Centroid,
  Constraints,
  DecisionRecord,
  DeploymentPlan,
  DeploymentRequest,
  DnsPlan,
  DnsProvider,
  DnsReadiness,
  ModuleSelection,
  Provider,
  ProviderReadiness,
  RegionPlan,
  TargetGeo,
} from "@geodeploy/core";
import { ALL_PROVIDERS, DeploymentPlanSchema } from "@geodeploy/core";
import { applyGate, breachesGlobalFloor, GATE_THRESHOLDS, regionSelectionThreshold } from "./gates.js";
import {
  composite,
  DEFAULT_WEIGHT_PROFILE,
  resolveWeights,
  type WeightProfileName,
} from "./composite.js";
import { buildStageAQuestions, buildStageBQuestions, candidateId, shortlistCandidates } from "./questions.js";
import {
  deterministicSizingTier,
  REGISTRY_DEFAULT_AUTOSCALING,
  REGISTRY_DEFAULT_INGRESS,
  selectCheapestPassingGates,
} from "./fallback.js";

// ---------------------------------------------------------------------------
// Stage B cluster/registry selection is a plain code lookup keyed by Stage
// A's chosen provider — never a TypeSafe call. There is exactly one legal
// answer once the provider is fixed (an AWS pick can only ever mean EKS +
// ECR), so asking the model would manufacture false confidence over a
// non-decision. Real question-asking in Stage B is reserved for ingress
// posture, autoscaling posture, and node-pool sizing tier (see questions.ts).
// ---------------------------------------------------------------------------
export const PROVIDER_TO_MODULES: Record<Provider, { cluster: string; registry: string }> = {
  aws: { cluster: "cluster.aws.eks", registry: "registry.aws.ecr" },
  azure: { cluster: "cluster.azure.aks", registry: "registry.azure.acr" },
  gcp: { cluster: "cluster.gcp.gke", registry: "registry.gcp.ar" },
};

// ---------------------------------------------------------------------------
// DNS backend selection — a separate, deterministic step, never a TypeSafe
// call. Choosing among interchangeable, equally-valid DNS backends based on
// which credentials are configured is a lookup, not a judgment call.
// ---------------------------------------------------------------------------
export const DEFAULT_DNS_PREFERENCE: readonly DnsProvider[] = ["route53", "ns1", "cloudflare"];

export function selectDnsBackend(
  dnsReadiness: DnsReadiness[],
  preference: readonly DnsProvider[] = DEFAULT_DNS_PREFERENCE,
): DnsPlan {
  const describe = (p: DnsProvider): string => {
    const r = dnsReadiness.find((x) => x.provider === p);
    if (!r) return `${p} (not detected)`;
    const tier2 = r.tier2 === null ? "unchecked (plan-time)" : String(r.tier2);
    return `${p} (tier1=${r.tier1}, tier2=${tier2}: ${r.detail})`;
  };

  for (const provider of preference) {
    const readiness = dnsReadiness.find((r) => r.provider === provider);
    // Usable at plan time: tier1 presence passed and tier2 hasn't explicitly
    // failed. Tier2 is only ever run at apply-time (per packages/detect's
    // design), so `null` here is the expected, normal plan-time state.
    if (readiness && readiness.tier1 && readiness.tier2 !== false) {
      return {
        provider,
        reason: `Selected ${provider} per preference order (${preference.join(" > ")}): ${describe(provider)}.`,
      };
    }
  }

  const checked = preference.map(describe).join("; ");
  return {
    provider: null,
    reason: `No DNS backend has usable credentials. Checked in preference order: ${checked}.`,
  };
}

/** From plan-time provider readiness (tier1 only — tier2 is apply-time only), is this provider provisionable right now? */
export function isProvisionable(provider: Provider, providerReadiness: ProviderReadiness[]): boolean {
  return providerReadiness.find((r) => r.provider === provider)?.tier1 === true;
}

// ---------------------------------------------------------------------------
// Per-geo decision (Stage A + Stage B), live-vs-fallback branching.
// ---------------------------------------------------------------------------

export interface DecideGeoInput {
  geo: TargetGeo;
  /** All scored candidates for this geo (packages/cost's output) — unfiltered, unshortlisted. */
  candidates: CandidateCost[];
  constraints: Constraints;
  weightProfile?: WeightProfileName | undefined;
  /** Whether this geo already has a deployed stack (affects the region-selection gate threshold). */
  isIncumbent?: boolean | undefined;
  /** Required when isIncumbent is true and the region-selection gate fails: the region to keep. */
  incumbentRegion?: { provider: Provider; region: string } | undefined;
  /**
   * The container image's built platforms (`DeploymentRequest.image.platforms`,
   * e.g. `["linux/amd64", "linux/arm64"]`) — Docker/build context fed into
   * Stage A's `archConsistency` question. Candidates are already hard-filtered
   * for architecture compatibility upstream (see @geodeploy/cost's
   * platformsToArches), so this is used only to describe the deployment's
   * build shape (single- vs. multi-arch), never to filter here.
   */
  imagePlatforms?: readonly string[] | undefined;
  /**
   * Architectures already committed to by geos decided earlier in this same
   * `buildDeploymentPlan` call (see engine.ts's sequential accumulation) — the
   * raw fact the `archConsistency` question is scored against.
   */
  committedArches?: ReadonlySet<Arch> | undefined;
}

export interface DecideGeoResult {
  provider: Provider;
  region: string;
  sku: string;
  arch: Arch;
  centroid: Centroid;
  nodesNeeded: number;
  monthlyUsd: number;
  moduleSelection: ModuleSelection;
  decisionRecords: DecisionRecord[];
  notes: string[];
}

/**
 * Thrown internally to unwind from decideGeoLive into the fallback branch
 * with a clear reason. Carries whatever real TypeSafe request/response data
 * was actually obtained before the abort, so a low-confidence (or otherwise
 * rejected) real answer is still recorded for audit — confirmed live: without
 * this, a genuine API call and response were silently discarded the moment
 * they triggered a fallback, undermining the "every call's state, questions,
 * answers... persisted" auditability the design promises (PROJECT-PLAN §5.5).
 */
export class AiPathAborted extends Error {
  constructor(
    message: string,
    public readonly attempt?: { state: unknown; questions: Record<string, unknown>; answers: Record<string, unknown> },
    /** A fully-formed Stage A decision record, when Stage B is what aborted (Stage A itself succeeded). */
    public readonly priorRecord?: DecisionRecord,
  ) {
    super(message);
  }
}

/**
 * Round-trip state through JSON so it structurally matches the SDK's
 * `EntryType` (a JSON-compatible value) — this also mirrors exactly what a
 * real HTTP request body would look like (undefined-valued optional fields,
 * like an unset `residency`, are dropped, exactly as `JSON.stringify` would).
 */
export function toState(value: unknown): EntryType {
  return JSON.parse(JSON.stringify(value)) as EntryType;
}

export function describeSdkError(err: unknown): string {
  if (err instanceof AuthenticationError) return `authentication failed (HTTP ${err.status})`;
  if (err instanceof APIConnectionError) return "network/connection failure";
  if (err instanceof APIError) return `API error (HTTP ${err.status})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function decideGeo(input: DecideGeoInput): Promise<DecideGeoResult> {
  if (input.candidates.length === 0) {
    throw new Error(`decideGeo: no candidates supplied for geo "${input.geo.id}"`);
  }

  const weightProfile = input.weightProfile ?? DEFAULT_WEIGHT_PROFILE;
  const apiKey = process.env["TYPESAFE_API_KEY"];
  const wantsLive = Boolean(apiKey && apiKey.trim().length > 0);

  if (!wantsLive) {
    return decideGeoFallback(input, "No TYPESAFE_API_KEY configured in the environment.");
  }

  try {
    return await decideGeoLive(input, weightProfile);
  } catch (err) {
    const reason = describeSdkError(err);
    const attempt = err instanceof AiPathAborted ? err.attempt : undefined;
    const priorRecord = err instanceof AiPathAborted ? err.priorRecord : undefined;
    return decideGeoFallback(input, `AI path aborted (${reason}).`, attempt, priorRecord);
  }
}

function buildModuleSelection(
  provider: Provider,
  ingress: string,
  autoscaling: string,
  sizing: string,
): ModuleSelection {
  return { ...PROVIDER_TO_MODULES[provider], ingress, autoscaling, sizing };
}

function decideGeoFallback(
  input: DecideGeoInput,
  prefix: string,
  attempt?: { state: unknown; questions: Record<string, unknown>; answers: Record<string, unknown> },
  priorRecord?: DecisionRecord,
): DecideGeoResult {
  const selection = selectCheapestPassingGates(input.candidates, input.geo, input.constraints);

  if (!selection.chosen) {
    throw new Error(`decideGeo: ${prefix} ${selection.reason}`);
  }

  const chosen = selection.chosen;
  const moduleSelection = buildModuleSelection(
    chosen.provider,
    REGISTRY_DEFAULT_INGRESS,
    REGISTRY_DEFAULT_AUTOSCALING,
    deterministicSizingTier(chosen.nodesNeeded),
  );

  const record: DecisionRecord = {
    geoId: input.geo.id,
    kind: "geo-selection",
    mode: "deterministic-fallback",
    selection: { provider: chosen.provider, region: chosen.region },
    reason: `${prefix} ${selection.reason}`,
    // A real TypeSafe call may well have happened and returned a real,
    // low-confidence (or otherwise rejected) answer before this fallback
    // ran — when it did, keep it here rather than discard it, so the audit
    // trail shows exactly what the model actually said, not just that it
    // was ignored.
    ...(attempt ? { state: attempt.state, questions: attempt.questions, answers: attempt.answers } : {}),
  };

  return {
    provider: chosen.provider,
    region: chosen.region,
    sku: chosen.sku,
    arch: chosen.arch,
    centroid: chosen.centroid,
    nodesNeeded: chosen.nodesNeeded,
    monthlyUsd: chosen.monthlyUsd,
    moduleSelection,
    // If Stage A itself fully succeeded and only Stage B aborted, keep
    // Stage A's real, gate-passing decision record in the audit trail
    // alongside the final fallback outcome, rather than silently replacing it.
    decisionRecords: priorRecord ? [priorRecord, record] : [record],
    notes: [],
  };
}

async function decideGeoLive(input: DecideGeoInput, weightProfile: WeightProfileName): Promise<DecideGeoResult> {
  const shortlisted = shortlistCandidates(input.candidates);
  if (shortlisted.length === 0) {
    throw new AiPathAborted("no candidates to shortlist");
  }

  const client = new TypeSafeClient();

  // -------------------------------------------------------------------
  // Stage A
  // -------------------------------------------------------------------
  const questionsA = buildStageAQuestions(shortlisted);
  const imagePlatforms = input.imagePlatforms ?? [];
  const stateA = {
    demandGeo: input.geo,
    candidates: shortlisted.map((c) => ({
      provider: c.provider,
      region: c.region,
      monthlyUsd: c.monthlyUsd,
      distanceKm: c.distanceKm,
      azCount: c.azCount,
      gaStatus: c.gaStatus,
      complianceFlags: c.complianceFlags,
      nodesNeeded: c.nodesNeeded,
      arch: c.arch,
    })),
    constraints: input.constraints,
    // Docker/build context for the archConsistency question — candidates
    // arriving here are already hard-filtered for architecture
    // compatibility (see @geodeploy/cost's platformsToArches), so this is
    // descriptive state for the model, never a filter applied here.
    image: {
      platforms: imagePlatforms,
      isMultiArch: imagePlatforms.length > 1,
      architecturesAlreadyCommitted: [...(input.committedArches ?? [])],
    },
  };
  const resultA = await client.systemOne({ state: toState(stateA), questions: questionsA });
  const a = resultA.answers;

  // Global floor: only the actual decision being made here (which region)
  // and the two hard compliance/capacity checks can abort the AI path.
  //
  // Confirmed live against a real TypeSafe org: coverage/costFit/maturity/
  // sprawlRisk/archConsistency are composite-scoring INPUTS, not decisions
  // in their own right — and real-world data regularly makes them
  // legitimately low-confidence for reasons that have nothing to do with
  // whether the region pick itself is sound. E.g. costFit's rubric asks for
  // a precise ratio-to-cutoff classification (1.05x/1.15x/1.3x/...); when a
  // real candidate's price lands near one of those boundaries, or is
  // exactly tied with another candidate, the model's honestly-uncertain
  // probability spread across adjacent bins is CORRECT behavior, not a
  // miscalibration — yet it was aborting a selection that was independently
  // 96-98% confident. `fallback` (the apply-time substitute pick) is
  // likewise a contingency answer, never the primary decision. All five
  // still feed `composite()` below and are recorded in the DecisionRecord
  // for audit — a shaky one just no longer discards an otherwise-confident
  // region pick.
  const floorChecks: Array<[string, number]> = [
    ["selection", a.selection.confidence],
    ["residencyOk", a.residencyOk.noul],
    ["capacityOk", a.capacityOk.noul],
  ];
  const stageAAttempt = { state: stateA, questions: questionsA, answers: a };

  for (const [name, value] of floorChecks) {
    if (breachesGlobalFloor(value)) {
      throw new AiPathAborted(
        `global floor breached on "${name}" (${value.toFixed(2)} < ${GATE_THRESHOLDS.globalFloor})`,
        stageAAttempt,
      );
    }
  }

  // residencyOk is a hard gate: below 0.95, hard-reject — never soft-fail a
  // compliance constraint, even by falling back to the model's own pick.
  const residencyGate = applyGate(a.residencyOk.noul, GATE_THRESHOLDS.residencyOk, "residencyOk");
  if (!residencyGate.passed) {
    throw new AiPathAborted(
      `residencyOk hard gate failed (${a.residencyOk.noul.toFixed(2)} < ${GATE_THRESHOLDS.residencyOk}); hard-rejecting the AI region selection`,
      stageAAttempt,
    );
  }
  // capacityOk has no dedicated numeric gate in the spec beyond the global
  // floor already checked above; recorded here for audit visibility.
  const capacityGate = applyGate(a.capacityOk.noul, GATE_THRESHOLDS.globalFloor, "capacityOk");

  const chosenId = a.selection.choice;
  let chosenCandidate = shortlisted.find((c) => candidateId(c) === chosenId);
  if (!chosenCandidate) {
    throw new AiPathAborted(`model selected an unknown candidate id "${chosenId}"`, stageAAttempt);
  }

  const regionThreshold = regionSelectionThreshold(Boolean(input.isIncumbent));
  const regionGate = applyGate(a.selection.confidence, regionThreshold, "regionSelection");

  let selectionNote: string | undefined;
  if (!regionGate.passed) {
    if (input.isIncumbent && input.incumbentRegion) {
      const incumbentCandidate = input.candidates.find(
        (c) => c.provider === input.incumbentRegion!.provider && c.region === input.incumbentRegion!.region,
      );
      if (!incumbentCandidate) {
        throw new AiPathAborted(
          `region-selection gate failed (incumbent, ${a.selection.confidence.toFixed(2)} < ${regionThreshold}) and incumbent region ${input.incumbentRegion.provider}:${input.incumbentRegion.region} is not present among candidates`,
          stageAAttempt,
        );
      }
      selectionNote = `Stage A region-selection confidence ${a.selection.confidence.toFixed(2)} is below the incumbent-stack threshold ${regionThreshold}; keeping incumbent region ${incumbentCandidate.provider}:${incumbentCandidate.region} instead of the model's pick (${chosenId}).`;
      chosenCandidate = incumbentCandidate;
    } else {
      const top3 = Object.entries(a.selection.probabilities)
        .sort(([, p1], [, p2]) => p2 - p1)
        .slice(0, 3)
        .map(([id, p]) => `${id} (p=${p.toFixed(2)})`)
        .join(", ");
      selectionNote = `Stage A region-selection confidence ${a.selection.confidence.toFixed(2)} is below the new-cluster threshold ${regionThreshold}; top-3 candidates require explicit human pick: ${top3}. Proceeding provisionally with the model's top pick (${chosenId}) pending review.`;
    }
  }

  const compositeValue = composite(
    {
      costFit: a.costFit.score,
      coverage: a.coverage.score,
      maturity: a.maturity.score,
      sprawlRisk: a.sprawlRisk.score,
      archConsistency: a.archConsistency.score,
    },
    resolveWeights(weightProfile),
  );

  const decisionRecordA: DecisionRecord = {
    geoId: input.geo.id,
    kind: "geo-selection",
    mode: "typesafe",
    state: stateA,
    questions: questionsA,
    answers: a,
    selection: { provider: chosenCandidate.provider, region: chosenCandidate.region },
    gates: { residencyOk: residencyGate, capacityOk: capacityGate, regionSelection: regionGate },
    composite: compositeValue,
    reason:
      selectionNote ??
      `Stage A selected ${chosenCandidate.provider}:${chosenCandidate.region} with confidence ${a.selection.confidence.toFixed(2)} (>= ${regionThreshold}); composite ${compositeValue.toFixed(3)} under the "${weightProfile}" weight profile.`,
  };

  // -------------------------------------------------------------------
  // Stage B — cluster/registry via lookup (never asked); ingress,
  // autoscaling, and node-pool sizing tier are genuinely open categories.
  // -------------------------------------------------------------------
  const questionsB = buildStageBQuestions();
  const stateB = {
    provider: chosenCandidate.provider,
    region: chosenCandidate.region,
    sku: chosenCandidate.sku,
    nodesNeeded: chosenCandidate.nodesNeeded,
    monthlyUsd: chosenCandidate.monthlyUsd,
    demandGeo: input.geo,
  };
  const resultB = await client.systemOne({ state: toState(stateB), questions: questionsB });
  const b = resultB.answers;

  for (const [name, value] of [
    ["ingress", b.ingress.confidence],
    ["autoscaling", b.autoscaling.confidence],
    ["sizing", b.sizing.confidence],
  ] as const) {
    if (breachesGlobalFloor(value)) {
      throw new AiPathAborted(
        `global floor breached on Stage B "${name}" (${value.toFixed(2)} < ${GATE_THRESHOLDS.globalFloor})`,
        { state: stateB, questions: questionsB, answers: b },
        decisionRecordA, // Stage A itself succeeded — keep its real decision in the audit trail.
      );
    }
  }

  const ingressGate = applyGate(b.ingress.confidence, GATE_THRESHOLDS.moduleSelection, "ingress");
  const autoscalingGate = applyGate(b.autoscaling.confidence, GATE_THRESHOLDS.moduleSelection, "autoscaling");
  const sizingGate = applyGate(b.sizing.confidence, GATE_THRESHOLDS.nodePoolSizing, "sizing");

  const ingress = ingressGate.passed ? b.ingress.choice : REGISTRY_DEFAULT_INGRESS;
  const autoscaling = autoscalingGate.passed ? b.autoscaling.choice : REGISTRY_DEFAULT_AUTOSCALING;
  const sizing = sizingGate.passed ? b.sizing.choice : deterministicSizingTier(chosenCandidate.nodesNeeded);

  const moduleSelection = buildModuleSelection(chosenCandidate.provider, ingress, autoscaling, sizing);

  const decisionRecordB: DecisionRecord = {
    geoId: input.geo.id,
    kind: "geo-selection",
    mode: "typesafe",
    state: stateB,
    questions: questionsB,
    answers: b,
    selection: { provider: chosenCandidate.provider, region: chosenCandidate.region },
    gates: { ingress: ingressGate, autoscaling: autoscalingGate, sizing: sizingGate },
    reason:
      `Stage B module selection for ${chosenCandidate.provider}:${chosenCandidate.region}: ` +
      `ingress=${ingress}${ingressGate.passed ? "" : " (gate failed, registry default used)"}, ` +
      `autoscaling=${autoscaling}${autoscalingGate.passed ? "" : " (gate failed, registry default used)"}, ` +
      `sizing=${sizing}${sizingGate.passed ? "" : " (gate failed, deterministic bin-packing result used)"}.`,
  };

  return {
    provider: chosenCandidate.provider,
    region: chosenCandidate.region,
    sku: chosenCandidate.sku,
    arch: chosenCandidate.arch,
    centroid: chosenCandidate.centroid,
    nodesNeeded: chosenCandidate.nodesNeeded,
    monthlyUsd: chosenCandidate.monthlyUsd,
    moduleSelection,
    decisionRecords: [decisionRecordA, decisionRecordB],
    notes: selectionNote ? [selectionNote] : [],
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration: Stage A + Stage B per geo, DNS selection, and
// assembly into a full DeploymentPlan.
// ---------------------------------------------------------------------------

export interface BuildDeploymentPlanInput {
  request: DeploymentRequest;
  /** geoId -> that geo's scored candidates (packages/cost's output). */
  candidatesByGeo: Record<string, CandidateCost[]>;
  /** Plan-time (tier1-only) provider readiness; empty/all-false is today's normal state. */
  providerReadiness: ProviderReadiness[];
  /** Plan-time DNS backend readiness. */
  dnsReadiness: DnsReadiness[];
  weightProfile?: WeightProfileName | undefined;
  /** geoId -> the region already deployed there, if any (affects the region-selection gate). */
  incumbentRegionByGeo?: Record<string, { provider: Provider; region: string }> | undefined;
  dnsPreference?: readonly DnsProvider[] | undefined;
  requestId?: string | undefined;
  now?: (() => Date) | undefined;
}

export async function buildDeploymentPlan(input: BuildDeploymentPlanInput): Promise<DeploymentPlan> {
  const now = input.now ?? (() => new Date());
  const regions: RegionPlan[] = [];
  const decisionRecords: DecisionRecord[] = [];
  const notes: string[] = [];
  const usedProviders = new Set<Provider>();
  // Accumulated sequentially across geos, in request order, so each geo's
  // archConsistency question is scored against exactly what was already
  // committed to *before* it — never including its own pick.
  const committedArches = new Set<Arch>();

  for (const geo of input.request.targetGeos) {
    const candidates = input.candidatesByGeo[geo.id] ?? [];
    const incumbentRegion = input.incumbentRegionByGeo?.[geo.id];

    const result = await decideGeo({
      geo,
      candidates,
      constraints: input.request.constraints,
      weightProfile: input.weightProfile,
      isIncumbent: Boolean(incumbentRegion),
      incumbentRegion,
      imagePlatforms: input.request.image.platforms,
      committedArches,
    });

    usedProviders.add(result.provider);
    committedArches.add(result.arch);
    decisionRecords.push(...result.decisionRecords);
    notes.push(...result.notes);

    regions.push({
      geoId: geo.id,
      provider: result.provider,
      region: result.region,
      sku: result.sku,
      centroid: result.centroid,
      demandCentroid: geo.centroid,
      nodesNeeded: result.nodesNeeded,
      monthlyUsd: result.monthlyUsd,
      provisionable: isProvisionable(result.provider, input.providerReadiness),
      modules: result.moduleSelection,
    });
  }

  if (usedProviders.size > input.request.constraints.maxProviders) {
    notes.push(
      `Warning: this plan uses ${usedProviders.size} distinct providers (${[...usedProviders].join(", ")}), ` +
        `exceeding constraints.maxProviders=${input.request.constraints.maxProviders}.`,
    );
  }

  const detectedProviders = input.providerReadiness.filter((r) => r.tier1).map((r) => r.provider);
  if (detectedProviders.length === 0) {
    notes.push("No configured providers detected; full comparison shown — supply credentials to enable provisioning.");
  }

  const allowedProviders =
    input.request.constraints.allowedProviders ?? (detectedProviders.length > 0 ? detectedProviders : [...ALL_PROVIDERS]);

  const dns = selectDnsBackend(input.dnsReadiness, input.dnsPreference);
  const totalMonthlyUsd = regions.reduce((sum, r) => sum + r.monthlyUsd, 0);

  const plan = {
    requestId: input.requestId ?? `plan-${now().toISOString()}`,
    createdAt: now().toISOString(),
    regions,
    dns,
    totalMonthlyUsd,
    decisionRecords,
    allowedProviders,
    detectedProviders,
    notes,
  };

  return DeploymentPlanSchema.parse(plan);
}
