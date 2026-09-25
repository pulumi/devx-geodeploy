import type { ComposeConfig } from "@geodeploy/compose";
import { composeProgram } from "@geodeploy/compose";
import type { DnsPlan, RegionPlan } from "@geodeploy/core";

export interface StackOutputValue {
  value: unknown;
  secret: boolean;
}

/** Raw Pulumi CLI output, streamed live as `preview()`/`up()` run — the same
 * mechanism used to show real-time progress in `pulumi up`/`pulumi destroy`
 * itself (Automation API's own `onOutput` option on both calls). */
export type StackOutputCallback = (chunk: string) => void;

/**
 * The minimal slice of the real Automation API `Stack` this package depends
 * on. Kept deliberately small (not the full `Stack` class) so tests can
 * inject a fake implementation without touching Pulumi at all — the real
 * `LocalWorkspace.createOrSelectStack(...)` result satisfies this shape.
 */
export interface StackLike {
  preview(opts?: { onOutput?: StackOutputCallback }): Promise<unknown>;
  up(opts?: { onOutput?: StackOutputCallback }): Promise<{ outputs: Record<string, StackOutputValue> }>;
}

/**
 * Real (default) path: creates or selects an Automation API stack backed by
 * `composeProgram`. Not exercised in the test suite — `pulumi.runtime.setMocks()`
 * does not survive being driven through the Automation API's real CLI
 * subprocess (confirmed empirically by the modules/compose work), so this
 * function is only reachable when a real Pulumi CLI + real cloud credentials
 * are present, which they never are in this environment today.
 */
async function createRealStack(regionPlan: RegionPlan, dnsPlan: DnsPlan, config: ComposeConfig): Promise<StackLike> {
  const { LocalWorkspace } = await import("@pulumi/pulumi/automation/index.js");
  const stack = await LocalWorkspace.createOrSelectStack({
    stackName: `geodeploy-${regionPlan.geoId}-${regionPlan.provider}`,
    projectName: "geodeploy",
    program: composeProgram(regionPlan, dnsPlan, config),
  });
  return stack;
}

/**
 * The minimal slice of the real Automation API `Stack` that reading back
 * outputs depends on. Deliberately separate from `StackLike`: a live-utilization
 * poll must never be able to call `preview()`/`up()` on the stack it reads,
 * so that path isn't even in this interface's surface.
 */
export interface StackOutputsLike {
  outputs(): Promise<Record<string, StackOutputValue>>;
}

/**
 * Real (default) path for `getRegionStackOutputs`: selects (never creates)
 * the already-provisioned Automation API stack. Not exercised in the test
 * suite for the same reason `createRealStack` isn't — see its comment.
 */
async function selectRealStack(regionPlan: RegionPlan, dnsPlan: DnsPlan, config: ComposeConfig): Promise<StackOutputsLike> {
  const { LocalWorkspace } = await import("@pulumi/pulumi/automation/index.js");
  const stack = await LocalWorkspace.selectStack({
    stackName: `geodeploy-${regionPlan.geoId}-${regionPlan.provider}`,
    projectName: "geodeploy",
    program: composeProgram(regionPlan, dnsPlan, config),
  });
  return stack;
}

export interface GetRegionStackOutputsOptions {
  /** Test seam: overrides how the already-provisioned stack's outputs are read. Defaults to the real Automation API path. */
  stack?: StackOutputsLike;
}

/**
 * Reads back the last-recorded outputs of an already-provisioned region's
 * stack -- including the per-region kubeconfig `composeProgram` marks secret
 * -- without ever calling `preview()`/`up()`. This is the read path a
 * live-utilization poll uses every cycle: `monitor.json`/`resize.json` never
 * need to carry cluster credentials themselves, since they're re-read from
 * Pulumi's own encrypted state each time.
 */
export async function getRegionStackOutputs(
  regionPlan: RegionPlan,
  dnsPlan: DnsPlan,
  config: ComposeConfig,
  opts: GetRegionStackOutputsOptions = {},
): Promise<Record<string, StackOutputValue>> {
  const stack = opts.stack ?? (await selectRealStack(regionPlan, dnsPlan, config));
  return stack.outputs();
}

export interface ProvisionRegionOptions {
  /** Test seam: overrides how the Stack for this region is obtained. Defaults to the real Automation API path. */
  stack?: StackLike;
  /** Streamed raw Pulumi CLI output from both `preview()` and `up()`, for live progress reporting (e.g. the web UI's Deploy panel). Never required — omitting it changes nothing about how provisioning itself runs. */
  onOutput?: StackOutputCallback;
}

/**
 * Provisions exactly one region: create-or-select the stack, always preview
 * first (per the plan's "always show a preview diff" default, even at high
 * confidence), then `up`. Returns the flattened stack outputs.
 */
export async function provisionRegion(
  regionPlan: RegionPlan,
  dnsPlan: DnsPlan,
  config: ComposeConfig,
  opts: ProvisionRegionOptions = {},
): Promise<Record<string, unknown>> {
  const stack = opts.stack ?? (await createRealStack(regionPlan, dnsPlan, config));
  const outputOpts = opts.onOutput ? { onOutput: opts.onOutput } : {};

  await stack.preview(outputOpts);
  const upResult = await stack.up(outputOpts);

  return Object.fromEntries(Object.entries(upResult.outputs).map(([key, out]) => [key, out.value]));
}
