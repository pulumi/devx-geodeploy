import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ComposeConfig } from "@geodeploy/compose";
import { ApplyRecordSchema, DeploymentPlanSchema, type ApplyRecord } from "@geodeploy/core";
import {
  checkApplyReadiness,
  provisionPlan,
  type ProvisionPlanResult,
  type RegionProvisionStatus,
} from "@geodeploy/provision";

export interface RunApplyOptions {
  planPath: string;
  /** Path to a `Record<geoId, ComposeConfig>` JSON file. Required once the plan is ready to apply. */
  configPath?: string;
  /** Directory `apply.json` is written to. Defaults to `process.cwd()`. */
  outDir?: string;
  /** Injectable clock, for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Raw Pulumi CLI output for one region, streamed live — for a caller reporting live progress (e.g. the web UI's Deploy panel). The CLI itself never passes this; only `geodeploy ui`'s apply endpoint does. */
  onRegionOutput?: (geoId: string, chunk: string) => void;
  /** Per-region provisioning milestones (running/succeeded/failed), coarser than `onRegionOutput`. */
  onRegionStatusChange?: (geoId: string, status: RegionProvisionStatus) => void;
}

export interface RunApplyResult {
  refused: boolean;
  blockers: string[];
  provisionResult?: ProvisionPlanResult;
  applyRecord: ApplyRecord;
  applyJsonPath: string;
}

/**
 * Loads the plan, runs the apply-time (tier1+tier2) readiness gate, and
 * refuses — without ever constructing a Pulumi `LocalWorkspace` — unless
 * every provider/DNS backend the plan needs is ready AND a `--config` file
 * was supplied. Only past both checks does it call `provisionPlan`.
 *
 * Every outcome — including a refusal — is persisted to `apply.json`
 * (mirroring how `plan.json` is always written by `runPlan`), so "not yet
 * provisioned" is a real, loadable artifact for any consumer (e.g. the web
 * GUI's "Pulumi State" modal), not something only ever printed to stdout.
 */
export async function runApply(opts: RunApplyOptions): Promise<RunApplyResult> {
  const raw = await readFile(opts.planPath, "utf8");
  const plan = DeploymentPlanSchema.parse(JSON.parse(raw));
  const now = opts.now ?? (() => new Date());
  const outDir = opts.outDir ?? process.cwd();

  const writeRecord = async (record: Omit<ApplyRecord, "requestId" | "checkedAt">): Promise<ApplyRecord> => {
    const applyRecord = ApplyRecordSchema.parse({
      requestId: plan.requestId,
      checkedAt: now().toISOString(),
      ...record,
    });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "apply.json"), JSON.stringify(applyRecord, null, 2), "utf8");
    return applyRecord;
  };

  const applyJsonPath = path.join(outDir, "apply.json");

  const readiness = await checkApplyReadiness(plan);
  if (!readiness.ready) {
    const applyRecord = await writeRecord({ refused: true, blockers: readiness.blockers });
    return { refused: true, blockers: readiness.blockers, applyRecord, applyJsonPath };
  }

  if (!opts.configPath) {
    const blockers = [
      "every provider/DNS backend is ready, but no --config <path-to-json> (Record<geoId, ComposeConfig>) was supplied",
    ];
    const applyRecord = await writeRecord({ refused: true, blockers });
    return { refused: true, blockers, applyRecord, applyJsonPath };
  }

  const configByGeo = JSON.parse(await readFile(opts.configPath, "utf8")) as Record<string, ComposeConfig>;
  const provisionResult = await provisionPlan(plan, configByGeo, {
    ...(opts.onRegionOutput ? { onRegionOutput: opts.onRegionOutput } : {}),
    ...(opts.onRegionStatusChange ? { onRegionStatusChange: opts.onRegionStatusChange } : {}),
  });
  const applyRecord = await writeRecord({ refused: false, blockers: [], results: provisionResult.results });
  return { refused: false, blockers: [], provisionResult, applyRecord, applyJsonPath };
}
