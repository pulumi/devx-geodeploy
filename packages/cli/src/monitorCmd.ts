import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ComposeConfig } from "@geodeploy/compose";
import {
  DeploymentPlanSchema,
  MonitorRecordSchema,
  ResizePlanSchema,
  type DeploymentPlan,
  type MonitorRecord,
  type RegionPlan,
  type ResizePlan,
} from "@geodeploy/core";
import { GATE_THRESHOLDS, decideResize, type DecideResizeResult } from "@geodeploy/decide";
import { collectUtilization, type CollectUtilizationOptions } from "@geodeploy/observe";
import { getAwsPriceQuote, getAzurePriceQuote, getGcpPriceQuote } from "@geodeploy/pricing";
import { runApply, type RunApplyResult } from "./applyCmd.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
// Bounds monitor.json's on-disk size for a long-running process; not
// prescribed by the plan, just ordinary housekeeping for an append-only log.
const MAX_MONITOR_HISTORY = 50;

/**
 * vCPU-per-node for a region's chosen sku, looked up from the same live
 * pricing adapters packages/cost uses at plan time (packages/pricing already
 * caches these responses, so a long-running monitor loop re-querying every
 * cycle is cheap after the first poll). packages/observe deliberately keeps
 * this out of its own dependency graph (see its collect.ts doc comment) —
 * the monitor loop is the caller that's expected to supply it.
 */
async function fetchVcpuPerNode(regionPlan: RegionPlan): Promise<number> {
  switch (regionPlan.provider) {
    case "aws":
      return (await getAwsPriceQuote({ region: regionPlan.region, instanceType: regionPlan.sku })).vcpu;
    case "azure":
      return (await getAzurePriceQuote({ region: regionPlan.region, armSkuName: regionPlan.sku })).vcpu;
    case "gcp":
      return (await getGcpPriceQuote({ region: regionPlan.region, machineType: regionPlan.sku })).vcpu;
  }
}

/**
 * `collectUtilization`'s `vcpuPerNodeForSku` is synchronous (called inline
 * inside its own per-region try/catch), but a real pricing lookup is a
 * network call — so the fetch happens up front, once per region per poll,
 * into a plain map; the sync function handed to `collectUtilization` only
 * ever reads that map. A region whose pricing lookup failed is left absent
 * from the map on purpose: the sync lookup throws for it, and
 * `collectUtilization`'s existing per-region isolation turns that into a
 * normal zeroed/errored `RegionUtilization` — no separate error handling
 * needed here.
 */
async function buildVcpuLookup(
  plan: DeploymentPlan,
  fetchOne: (regionPlan: RegionPlan) => Promise<number>,
): Promise<(regionPlan: RegionPlan) => number> {
  const vcpuByGeoId = new Map<string, number>();
  await Promise.all(
    plan.regions.map(async (region) => {
      try {
        vcpuByGeoId.set(region.geoId, await fetchOne(region));
      } catch {
        // left absent — see doc comment above.
      }
    }),
  );
  return (regionPlan: RegionPlan): number => {
    const vcpu = vcpuByGeoId.get(regionPlan.geoId);
    if (vcpu === undefined) {
      throw new Error(`no vcpu-per-node figure available for geoId "${regionPlan.geoId}" (sku "${regionPlan.sku}")`);
    }
    return vcpu;
  };
}

/**
 * A resize is eligible for unattended (autonomous mode) apply when either:
 *  - the live TypeSafe path ran and its `topology` choice's confidence
 *    cleared the *stricter* `resizeTopologyAutoApply` gate (0.85) — not just
 *    the lower `resizeTopologySuggest` gate (0.7) `DecideResizeResult.
 *    confidencePassed` reflects. `decideResize` doesn't expose that stricter
 *    check directly (its public result only distinguishes "worth
 *    suggesting" from "not"), so it's re-derived here from the raw gate
 *    value already recorded on the last `DecisionRecord` for full audit
 *    fidelity.
 *  - or the decision came from the deterministic fallback path, which is
 *    pure, safe-by-construction arithmetic (per-region scale up/down only,
 *    never a cross-region shift — see resize-fallback.ts) and therefore
 *    always safe to apply unattended on its own terms.
 * Either way, a resize whose every action is "no-change" is never "applied"
 * — there is nothing to apply.
 */
function isEligibleForAutoApply(decision: DecideResizeResult): boolean {
  const anyChange = decision.actions.some((a) => a.action !== "no-change");
  if (!anyChange) return false;

  const lastRecord = decision.decisionRecords[decision.decisionRecords.length - 1];
  if (lastRecord?.mode === "deterministic-fallback") return true;

  const topologyGateValue = lastRecord?.gates?.["topology"]?.value;
  return topologyGateValue !== undefined && topologyGateValue >= GATE_THRESHOLDS.resizeTopologyAutoApply;
}

export interface RunMonitorOptions {
  planPath: string;
  /** Path to a `Record<geoId, ComposeConfig>` JSON file. */
  configPath: string;
  /** Directory `monitor.json` is written to. Defaults to `process.cwd()`. */
  outDir?: string;
  /** Poll interval in milliseconds. Defaults to 5 minutes. */
  intervalMs?: number;
  mode?: "approval-gated" | "autonomous";
  /** Injectable clock, for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Test seam: stop after this many polls instead of running forever. */
  maxIterations?: number;
  /** Test seam: skip the real wait between polls. Defaults to `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: overrides how each poll's utilization snapshot is collected. Defaults to the real Metrics-API path via `collectUtilization`. */
  collectUtilizationOverrides?: CollectUtilizationOptions;
  /** Test seam: overrides the per-region vcpu-per-node lookup. Defaults to real `@geodeploy/pricing` calls via `fetchVcpuPerNode`. */
  vcpuPerNodeForSku?: (regionPlan: RegionPlan) => Promise<number>;
}

export interface RunMonitorResult {
  /** Stops the polling loop after its current iteration finishes. Safe to call more than once. */
  stop: () => void;
  monitorJsonPath: string;
  /** Resolves once the loop has stopped (either `maxIterations` was reached, or `stop()` was called). */
  done: Promise<void>;
}

async function writeMonitorJson(monitorJsonPath: string, record: MonitorRecord): Promise<void> {
  await mkdir(path.dirname(monitorJsonPath), { recursive: true });
  await writeFile(monitorJsonPath, JSON.stringify(record, null, 2), "utf8");
}

/** Filename for the live mode-override control file — see `writeMonitorModeControl`'s doc comment. */
export const MONITOR_CONTROL_FILENAME = "monitor-control.json";

/**
 * Writes a small control file the running monitor loop re-reads at the top
 * of every poll (see `readMonitorModeControl`/`pollOnce` below), so a mode
 * change from the web UI (`POST /api/monitor/mode`) takes effect on the
 * *next* poll without needing to restart the `geodeploy monitor` process —
 * `monitor` and `ui` are separate processes coordinating only through files
 * on disk, the same way every other piece of state here does (plan.json,
 * apply.json, monitor.json itself).
 */
export async function writeMonitorModeControl(outDir: string, mode: "approval-gated" | "autonomous"): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, MONITOR_CONTROL_FILENAME), JSON.stringify({ mode }, null, 2), "utf8");
}

/** Returns the live mode override, or `null` if no control file exists or it doesn't parse — callers fall back to the mode the process was started with. */
async function readMonitorModeControl(outDir: string): Promise<"approval-gated" | "autonomous" | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(outDir, MONITOR_CONTROL_FILENAME), "utf8")) as { mode?: unknown };
    return raw.mode === "approval-gated" || raw.mode === "autonomous" ? raw.mode : null;
  } catch {
    return null;
  }
}

export async function runMonitor(opts: RunMonitorOptions): Promise<RunMonitorResult> {
  const outDir = opts.outDir ?? process.cwd();
  const now = opts.now ?? (() => new Date());
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startupMode = opts.mode ?? "approval-gated";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const monitorJsonPath = path.join(outDir, "monitor.json");

  // Only used to validate the plan/config files actually exist and parse
  // before starting the loop — every value that can meaningfully change
  // between polls (plan, config, mode) is re-read fresh inside pollOnce
  // itself, never from a startup-time snapshot.
  await DeploymentPlanSchema.parse(JSON.parse(await readFile(opts.planPath, "utf8")));
  JSON.parse(await readFile(opts.configPath, "utf8"));

  let history: ResizePlan[] = [];
  let stopped = false;

  async function pollOnce(): Promise<void> {
    // Re-read plan.json AND config.json fresh every cycle: autonomous mode
    // may have overwritten plan.json (via applyPendingResize) on a previous
    // cycle, and a user can add/edit ComposeConfig entries (e.g. after the
    // wizard adds a new region) without restarting this process — confirmed
    // live: reading config.json only once at startup left every later
    // update to it silently ignored for the rest of the process's life,
    // surfacing as a permanent "no ComposeConfig supplied" error even after
    // the file on disk was fixed. The mode itself is similarly re-resolved
    // every cycle (control file, falling back to how this process was
    // started) so a live UI toggle takes effect without a restart.
    const plan = DeploymentPlanSchema.parse(JSON.parse(await readFile(opts.planPath, "utf8")));
    const mode = (await readMonitorModeControl(outDir)) ?? startupMode;

    try {
      const configByGeo = JSON.parse(await readFile(opts.configPath, "utf8")) as Record<string, ComposeConfig>;
      const vcpuPerNodeForSku = await buildVcpuLookup(plan, opts.vcpuPerNodeForSku ?? fetchVcpuPerNode);
      const utilization = await collectUtilization(
        { plan, composeConfigByGeo: configByGeo, vcpuPerNodeForSku, now },
        opts.collectUtilizationOverrides,
      );
      const decision = await decideResize({ plan, utilization });

      let resize: ResizePlan = ResizePlanSchema.parse({
        requestId: plan.requestId,
        createdAt: now().toISOString(),
        utilization,
        actions: decision.actions,
        updatedRegions: decision.updatedRegions,
        decisionRecords: decision.decisionRecords,
        confidencePassed: decision.confidencePassed,
        mode,
        applied: false,
        reason: decision.reason,
      });

      if (mode === "autonomous" && isEligibleForAutoApply(decision)) {
        // Persist the not-yet-applied resize first, so monitor.json always
        // reflects reality even if the apply step below fails partway.
        history = [...history, resize].slice(-MAX_MONITOR_HISTORY);
        await writeMonitorJson(
          monitorJsonPath,
          MonitorRecordSchema.parse({
            requestId: plan.requestId,
            mode,
            pollIntervalMs: intervalMs,
            lastPolledAt: now().toISOString(),
            lastResize: resize,
            history,
            status: "running",
          }),
        );
        await applyPendingResize({ planPath: opts.planPath, monitorDir: outDir, configPath: opts.configPath, now });
        resize = { ...resize, applied: true };
        history = history.map((r) => (r.createdAt === resize.createdAt ? resize : r));
      } else {
        history = [...history, resize].slice(-MAX_MONITOR_HISTORY);
      }

      await writeMonitorJson(
        monitorJsonPath,
        MonitorRecordSchema.parse({
          requestId: plan.requestId,
          mode,
          pollIntervalMs: intervalMs,
          lastPolledAt: now().toISOString(),
          lastResize: resize,
          history,
          status: "running",
        }),
      );
    } catch (err) {
      await writeMonitorJson(
        monitorJsonPath,
        MonitorRecordSchema.parse({
          requestId: plan.requestId,
          mode,
          pollIntervalMs: intervalMs,
          lastPolledAt: now().toISOString(),
          history,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  (async () => {
    let iterations = 0;
    for (;;) {
      if (stopped) break;
      await pollOnce();
      iterations += 1;
      if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) break;
      if (stopped) break;
      await sleep(intervalMs);
    }
    resolveDone?.();
  })();

  return {
    stop: () => {
      stopped = true;
    },
    monitorJsonPath,
    done,
  };
}

export interface ApplyPendingResizeOptions {
  /** Path to the plan.json the pending resize applies against (overwritten in place, same file `geodeploy plan`/`apply` use). */
  planPath: string;
  /** Directory monitor.json lives in (and where apply.json is written, matching the monitor loop's own output directory). */
  monitorDir: string;
  configPath: string;
  now?: () => Date;
}

/**
 * Applies the most recent pending resize recorded in `monitor.json`: writes
 * its `updatedRegions` into `plan.json` (in place, the same file `apply`
 * itself reads), calls the existing `runApply` — so a resize is applied
 * through exactly the same, single "how a plan gets applied" code path a
 * human's `geodeploy plan` -> `geodeploy apply` would use, keeping
 * `apply.json`'s history a truthful record of what was actually asked for at
 * each point in time — then marks that resize `applied: true` in
 * `monitor.json`. Shared by both the autonomous polling loop (§ above) and a
 * human-triggered apply, whether via the `apply-resize` CLI subcommand or
 * the web UI's `POST /api/resize/apply`.
 */
export async function applyPendingResize(opts: ApplyPendingResizeOptions): Promise<RunApplyResult> {
  const monitorJsonPath = path.join(opts.monitorDir, "monitor.json");
  const monitorRecord = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));

  const resize = monitorRecord.lastResize;
  if (!resize) {
    throw new Error(`applyPendingResize: no resize recorded in ${monitorJsonPath}`);
  }
  if (resize.applied) {
    throw new Error(`applyPendingResize: the most recent resize in ${monitorJsonPath} was already applied`);
  }

  const plan = DeploymentPlanSchema.parse(JSON.parse(await readFile(opts.planPath, "utf8")));
  const updatedPlan: DeploymentPlan = { ...plan, regions: resize.updatedRegions };
  await writeFile(opts.planPath, JSON.stringify(updatedPlan, null, 2), "utf8");

  const result = await runApply({
    planPath: opts.planPath,
    configPath: opts.configPath,
    outDir: opts.monitorDir,
    ...(opts.now ? { now: opts.now } : {}),
  });

  const appliedResize: ResizePlan = { ...resize, applied: true };
  const updatedHistory = monitorRecord.history.map((r) => (r.createdAt === resize.createdAt ? appliedResize : r));
  await writeMonitorJson(
    monitorJsonPath,
    MonitorRecordSchema.parse({ ...monitorRecord, lastResize: appliedResize, history: updatedHistory }),
  );

  return result;
}
