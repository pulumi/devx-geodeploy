import type { ComposeConfig } from "@geodeploy/compose";
import type { DeploymentPlan, DnsPlan, RegionPlan } from "@geodeploy/core";
import { checkApplyReadiness } from "./readiness.js";
import { provisionRegion, type StackLike, type StackOutputCallback } from "./stack.js";

export type RegionProvisionStatus = "running" | "succeeded" | "failed";

export interface ProvisionOutcome {
  status: "succeeded" | "failed";
  error?: string;
  outputs?: Record<string, unknown>;
}

export interface ProvisionPlanResult {
  results: Record<string, ProvisionOutcome>;
}

export interface ProvisionPlanOptions {
  /** Max regions provisioned concurrently. Default 4. */
  concurrency?: number;
  /** Test seam: overrides how the Stack for a given region is obtained. Defaults to the real Automation API path. */
  stackFor?: (regionPlan: RegionPlan, dnsPlan: DnsPlan, config: ComposeConfig) => Promise<StackLike>;
  /** Raw Pulumi CLI output for one region, streamed live as it provisions — for a caller reporting live progress (e.g. the web UI's Deploy panel). Optional; omitting it changes nothing about how provisioning runs. */
  onRegionOutput?: (geoId: string, chunk: string) => void;
  /** Fired once when a region starts provisioning and once with its final outcome — coarser than `onRegionOutput`, for a caller that only wants per-region milestones (e.g. a status pill) without parsing raw CLI text. */
  onRegionStatusChange?: (geoId: string, status: RegionProvisionStatus) => void;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Orchestrates provisioning of every region in a plan with bounded
 * parallelism. Refuses up front (throws) if `checkApplyReadiness` reports any
 * blocker, so a real `LocalWorkspace`/`Stack` is never constructed for a plan
 * that isn't ready for apply — this is an all-or-nothing gate on the whole
 * plan, checked once before any region's work begins.
 *
 * Once past the gate, a failure in one region's `up()` is caught and
 * recorded as `status: "failed"` for that geo only; it never rejects the
 * overall call and never affects any other region's outcome (per the
 * design's "a failed region does not roll back healthy ones").
 */
export async function provisionPlan(
  plan: DeploymentPlan,
  configByGeo: Record<string, ComposeConfig>,
  opts: ProvisionPlanOptions = {},
): Promise<ProvisionPlanResult> {
  const readiness = await checkApplyReadiness(plan);
  if (!readiness.ready) {
    throw new Error(
      `provisionPlan refused: apply-time readiness check failed:\n${readiness.blockers.map((b) => `  - ${b}`).join("\n")}`,
    );
  }

  const results: Record<string, ProvisionOutcome> = {};
  const regions = plan.regions;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, regions.length || 1));

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= regions.length) return;
      const regionPlan = regions[i]!;
      const config = configByGeo[regionPlan.geoId];

      if (!config) {
        results[regionPlan.geoId] = {
          status: "failed",
          error: `no ComposeConfig supplied for geoId "${regionPlan.geoId}"`,
        };
        continue;
      }

      opts.onRegionStatusChange?.(regionPlan.geoId, "running");
      try {
        const stack = opts.stackFor ? await opts.stackFor(regionPlan, plan.dns, config) : undefined;
        const onOutput: StackOutputCallback | undefined = opts.onRegionOutput
          ? (chunk) => opts.onRegionOutput!(regionPlan.geoId, chunk)
          : undefined;
        const outputs = await provisionRegion(regionPlan, plan.dns, config, {
          ...(stack ? { stack } : {}),
          ...(onOutput ? { onOutput } : {}),
        });
        results[regionPlan.geoId] = { status: "succeeded", outputs };
        opts.onRegionStatusChange?.(regionPlan.geoId, "succeeded");
      } catch (err) {
        results[regionPlan.geoId] = { status: "failed", error: err instanceof Error ? err.message : String(err) };
        opts.onRegionStatusChange?.(regionPlan.geoId, "failed");
      }
    }
  }

  const workers = Array.from({ length: regions.length === 0 ? 0 : concurrency }, () => worker());
  await Promise.allSettled(workers);

  return { results };
}
