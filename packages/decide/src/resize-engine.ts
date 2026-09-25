import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { DecisionRecord, DeploymentPlan, RegionPlan, RegionResizeAction, UtilizationSnapshot } from "@geodeploy/core";
import { AiPathAborted, describeSdkError, toState } from "./engine.js";
import { applyGate, breachesGlobalFloor, GATE_THRESHOLDS } from "./gates.js";
import { buildResizeQuestions } from "./resize-questions.js";
import { deterministicResizeActions, scaledDownNodes, scaledUpNodes } from "./resize-fallback.js";
import type { WeightProfileName } from "./composite.js";

// ---------------------------------------------------------------------------
// Resize/rebalance decision, live-vs-fallback branching. Deliberately a
// SEPARATE decision function from decideGeo/buildDeploymentPlan in engine.ts
// (not an extension of it): resize reasons over all currently-deployed
// regions together, using observed utilization, rather than a per-geo
// shortlist of unpriced candidates. Control flow mirrors decideGeo exactly
// (env var gate -> live path in try -> AiPathAborted unwind -> fallback with
// the real partial attempt preserved) by reusing engine.ts's exported
// toState/describeSdkError/AiPathAborted rather than duplicating them.
// ---------------------------------------------------------------------------

export interface DecideResizeInput {
  plan: DeploymentPlan;
  utilization: UtilizationSnapshot;
  weightProfile?: WeightProfileName | undefined;
  maxMonthlyUsd?: number | undefined;
}

export interface DecideResizeResult {
  actions: RegionResizeAction[];
  /** Ready to feed straight back into provisionPlan. */
  updatedRegions: RegionPlan[];
  decisionRecords: DecisionRecord[];
  /** Gated at GATE_THRESHOLDS.resizeTopologySuggest at minimum. */
  confidencePassed: boolean;
  reason: string;
}

/**
 * Cross-region shift delta rule (the plan doesn't prescribe exact math here,
 * so this is a deliberate, documented choice): a chosen "shift:A->B" moves a
 * fixed 30% of the source region's *current* node capacity to the
 * destination, always retaining at least 1 node at the source. A fixed
 * fraction — rather than "all excess capacity" or "just enough to equalize
 * both regions' utilization percentages" — is deliberately conservative: the
 * model has judged a shift is *directionally* right (exactly the judgment
 * call deterministicResizeActions's code-only rule can't safely make), but
 * moving too much capacity in one resize cycle risks under-provisioning the
 * source before the destination's enlarged pool is confirmed healthy. 30%
 * produces a meaningful, visible move without fully draining the source or
 * doubling the destination in a single step; a persistent imbalance is
 * expected to trigger further shifts on subsequent monitor-loop iterations.
 */
export const SHIFT_SOURCE_RETAIN_FRACTION = 0.7;

/** Build the "no-change" action list: one no-change entry per region, so `actions.length` is always `plan.regions.length` regardless of which topology choice was made. */
function noChangeActions(plan: DeploymentPlan): RegionResizeAction[] {
  return plan.regions.map((r) => ({ geoId: r.geoId, action: "no-change" as const }));
}

/**
 * Parse a model-chosen topology id (see resize-questions.ts's
 * buildTopologyOptions) back into concrete RegionResizeAction[]. The model
 * decides WHICH region(s) and WHICH direction; the exact node-count delta is
 * always deterministic arithmetic (scaledUpNodes/scaledDownNodes for a
 * single-region resize, SHIFT_SOURCE_RETAIN_FRACTION for a shift) — never
 * asked of the model itself.
 */
export function decomposeTopologyChoice(choiceId: string, plan: DeploymentPlan): RegionResizeAction[] {
  if (choiceId === "no-change") return noChangeActions(plan);

  const scaleUpMatch = /^scale-up:(.+)$/.exec(choiceId);
  if (scaleUpMatch) {
    const geoId = scaleUpMatch[1]!;
    const region = plan.regions.find((r) => r.geoId === geoId);
    if (!region) throw new Error(`decideResize: scale-up topology choice "${choiceId}" references an unknown region`);
    return plan.regions.map((r) =>
      r.geoId === geoId
        ? { geoId, action: "scale-up" as const, newNodesNeeded: scaledUpNodes(region.nodesNeeded) }
        : { geoId: r.geoId, action: "no-change" as const },
    );
  }

  const scaleDownMatch = /^scale-down:(.+)$/.exec(choiceId);
  if (scaleDownMatch) {
    const geoId = scaleDownMatch[1]!;
    const region = plan.regions.find((r) => r.geoId === geoId);
    if (!region) throw new Error(`decideResize: scale-down topology choice "${choiceId}" references an unknown region`);
    return plan.regions.map((r) =>
      r.geoId === geoId
        ? { geoId, action: "scale-down" as const, newNodesNeeded: scaledDownNodes(region.nodesNeeded) }
        : { geoId: r.geoId, action: "no-change" as const },
    );
  }

  const shiftMatch = /^shift:(.+)->(.+)$/.exec(choiceId);
  if (shiftMatch) {
    const fromGeoId = shiftMatch[1]!;
    const toGeoId = shiftMatch[2]!;
    const source = plan.regions.find((r) => r.geoId === fromGeoId);
    const dest = plan.regions.find((r) => r.geoId === toGeoId);
    if (!source || !dest) {
      throw new Error(`decideResize: shift topology choice "${choiceId}" references an unknown region`);
    }
    const sourceNewNodes = Math.max(1, Math.floor(source.nodesNeeded * SHIFT_SOURCE_RETAIN_FRACTION));
    const nodesMoved = source.nodesNeeded - sourceNewNodes;
    const destNewNodes = dest.nodesNeeded + nodesMoved;
    return plan.regions.map((r) => {
      if (r.geoId === fromGeoId) {
        return { geoId: fromGeoId, action: "shift-out" as const, newNodesNeeded: sourceNewNodes, pairedGeoId: toGeoId };
      }
      if (r.geoId === toGeoId) {
        return { geoId: toGeoId, action: "shift-in" as const, newNodesNeeded: destNewNodes, pairedGeoId: fromGeoId };
      }
      return { geoId: r.geoId, action: "no-change" as const };
    });
  }

  throw new Error(`decideResize: model selected an unknown topology choice "${choiceId}"`);
}

/** Apply each action's newSku/newNodesNeeded onto a copy of the matching RegionPlan; "no-change" regions are copied unchanged. */
function applyActionsToRegions(regions: RegionPlan[], actions: RegionResizeAction[]): RegionPlan[] {
  const actionByGeo = new Map(actions.map((a) => [a.geoId, a]));
  return regions.map((region) => {
    const action = actionByGeo.get(region.geoId);
    if (!action || action.action === "no-change") {
      return { ...region };
    }
    return {
      ...region,
      sku: action.newSku ?? region.sku,
      nodesNeeded: action.newNodesNeeded ?? region.nodesNeeded,
    };
  });
}

/**
 * DecisionRecordSchema's `geoId`/`selection` fields are shaped for a
 * single-geo decision (Stage A/B); resize is a joint decision across every
 * currently-deployed region. Rather than extend the schema, we record the
 * region actually acted upon (or the first region, when every action is
 * no-change) as the record's nominal geoId/selection — the full picture of
 * every region's action lives in `actions`/`answers`, this only satisfies
 * the schema's required single-region fields for audit indexing.
 */
function pickPrimaryRegion(actions: RegionResizeAction[], plan: DeploymentPlan): RegionPlan {
  const acted = actions.find((a) => a.action !== "no-change");
  const geoId = acted?.geoId ?? plan.regions[0]!.geoId;
  return plan.regions.find((r) => r.geoId === geoId) ?? plan.regions[0]!;
}

export async function decideResize(input: DecideResizeInput): Promise<DecideResizeResult> {
  if (input.plan.regions.length === 0) {
    throw new Error("decideResize: plan has no regions to resize");
  }

  const apiKey = process.env["TYPESAFE_API_KEY"];
  const wantsLive = Boolean(apiKey && apiKey.trim().length > 0);

  if (!wantsLive) {
    return decideResizeFallback(input, "No TYPESAFE_API_KEY configured in the environment.");
  }

  try {
    return await decideResizeLive(input);
  } catch (err) {
    const reason = describeSdkError(err);
    const attempt = err instanceof AiPathAborted ? err.attempt : undefined;
    const priorRecord = err instanceof AiPathAborted ? err.priorRecord : undefined;
    return decideResizeFallback(input, `AI path aborted (${reason}).`, attempt, priorRecord);
  }
}

function decideResizeFallback(
  input: DecideResizeInput,
  prefix: string,
  attempt?: { state: unknown; questions: Record<string, unknown>; answers: Record<string, unknown> },
  priorRecord?: DecisionRecord,
): DecideResizeResult {
  const actions = deterministicResizeActions(input.plan, input.utilization);
  const updatedRegions = applyActionsToRegions(input.plan.regions, actions);
  const primary = pickPrimaryRegion(actions, input.plan);

  const changed = actions.filter((a) => a.action !== "no-change");
  const reason =
    `${prefix} Deterministic fallback: ` +
    (changed.length === 0
      ? "no region's observed utilization crossed the scale-up/scale-down thresholds; no changes proposed."
      : changed.map((a) => `${a.geoId} -> ${a.action} (newNodesNeeded=${a.newNodesNeeded})`).join(", ") + ".");

  const record: DecisionRecord = {
    geoId: primary.geoId,
    kind: "resize",
    mode: "deterministic-fallback",
    selection: { provider: primary.provider, region: primary.region },
    reason,
    // A real TypeSafe call may well have happened and returned a real,
    // low-confidence (or otherwise rejected) answer before this fallback
    // ran — when it did, keep it here rather than discard it (see
    // engine.ts's AiPathAborted for the identical rationale).
    ...(attempt ? { state: attempt.state, questions: attempt.questions, answers: attempt.answers } : {}),
  };

  return {
    actions,
    updatedRegions,
    decisionRecords: priorRecord ? [priorRecord, record] : [record],
    confidencePassed: false,
    reason,
  };
}

async function decideResizeLive(input: DecideResizeInput): Promise<DecideResizeResult> {
  const client = new TypeSafeClient();
  const questions = buildResizeQuestions(input.plan, input.utilization);

  const state = {
    regions: input.plan.regions.map((r) => ({
      geoId: r.geoId,
      provider: r.provider,
      region: r.region,
      sku: r.sku,
      nodesNeeded: r.nodesNeeded,
      monthlyUsd: r.monthlyUsd,
    })),
    utilization: input.utilization.regions,
    weightProfile: input.weightProfile ?? null,
    maxMonthlyUsd: input.maxMonthlyUsd ?? null,
  };

  const result = await client.systemOne({ state: toState(state), questions });
  const a = result.answers;
  const attempt = { state, questions, answers: a };

  // Global floor: any decision below 0.50 aborts the AI path entirely, same
  // as Stage A/B in engine.ts.
  const floorChecks: Array<[string, number]> = [
    ["topology", a.topology.confidence],
    ["confidence", a.confidence.confidence],
    ["riskOfDisruption", a.riskOfDisruption.noul],
  ];
  for (const [name, value] of floorChecks) {
    if (breachesGlobalFloor(value)) {
      throw new AiPathAborted(
        `global floor breached on "${name}" (${value.toFixed(2)} < ${GATE_THRESHOLDS.globalFloor})`,
        attempt,
      );
    }
  }

  const topologyGate = applyGate(a.topology.confidence, GATE_THRESHOLDS.resizeTopologySuggest, "topology");
  // riskOfDisruption has no dedicated numeric gate beyond the global floor
  // already checked above; recorded here for audit visibility, mirroring
  // Stage A's capacityOk treatment in engine.ts.
  const riskGate = applyGate(a.riskOfDisruption.noul, GATE_THRESHOLDS.globalFloor, "riskOfDisruption");

  let actions: RegionResizeAction[];
  let actionReason: string;
  if (topologyGate.passed) {
    actions = decomposeTopologyChoice(a.topology.choice, input.plan);
    actionReason =
      `Model chose topology action "${a.topology.choice}" with confidence ${a.topology.confidence.toFixed(2)} ` +
      `(>= ${GATE_THRESHOLDS.resizeTopologySuggest}); node-count deltas computed deterministically ` +
      `(see resize-fallback.ts's scaledUpNodes/scaledDownNodes and SHIFT_SOURCE_RETAIN_FRACTION for a shift).`;
  } else {
    actions = deterministicResizeActions(input.plan, input.utilization);
    actionReason =
      `Model's topology confidence ${a.topology.confidence.toFixed(2)} is below the suggest threshold ` +
      `${GATE_THRESHOLDS.resizeTopologySuggest}; used the deterministic per-region utilization fallback instead ` +
      `of the model's specific pick ("${a.topology.choice}").`;
  }

  const updatedRegions = applyActionsToRegions(input.plan.regions, actions);
  const primary = pickPrimaryRegion(actions, input.plan);

  const decisionRecord: DecisionRecord = {
    geoId: primary.geoId,
    kind: "resize",
    mode: "typesafe",
    state,
    questions,
    answers: a,
    selection: { provider: primary.provider, region: primary.region },
    gates: { topology: topologyGate, riskOfDisruption: riskGate },
    reason: actionReason,
  };

  return {
    actions,
    updatedRegions,
    decisionRecords: [decisionRecord],
    confidencePassed: topologyGate.passed,
    reason: actionReason,
  };
}
