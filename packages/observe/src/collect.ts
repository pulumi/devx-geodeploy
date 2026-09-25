import type { DeploymentPlan, DnsPlan, RegionPlan, RegionUtilization, UtilizationSnapshot } from "@geodeploy/core";
import { getRegionStackOutputs, type StackOutputValue } from "@geodeploy/provision";
import { metricsClientForRegion, type RegionMetricsClient } from "./client.js";

/**
 * `@geodeploy/observe` deliberately doesn't depend on `@geodeploy/compose`
 * for the `ComposeConfig` type: the only thing this package does with it is
 * forward it, opaquely, into `getRegionStackOutputs`'s third argument (which
 * needs it to rebuild the same inline Pulumi program `composeProgram` used
 * at apply time, so `LocalWorkspace.selectStack` can select it). Typing it
 * as `unknown` here -- and casting only inside the default `getStackOutputsFor`
 * wiring below -- avoids adding a fourth workspace dependency purely for a
 * type this package never inspects.
 */
export type OpaqueComposeConfig = unknown;

export interface CollectUtilizationInput {
  plan: DeploymentPlan;
  composeConfigByGeo: Record<string, OpaqueComposeConfig>;
  /**
   * vCPU-per-node for a region's chosen `sku` -- the utilization baseline is
   * `nodeCount * vcpuPerNodeForSku(regionPlan)`. Deliberately a
   * caller-supplied lookup rather than this package calling
   * `packages/pricing` itself: that would give a live-metrics poll its own
   * network-calling pricing dependency (with pricing's own caching/rate-limit
   * concerns) just to answer "how big is a node", when the caller (the
   * `geodeploy monitor` loop) already has -- or can cheaply derive once per
   * poll from `packages/pricing`'s price-quote data (`PriceQuote.vcpu`) --
   * this exact figure per `RegionPlan.sku`. Keeps `@geodeploy/observe`'s only
   * real (network-calling) dependency the K8s Metrics API.
   */
  vcpuPerNodeForSku: (regionPlan: RegionPlan) => number;
  /** Test seam: overrides the clock used to stamp `observedAt`/`collectedAt`. */
  now?: () => Date;
}

export interface CollectUtilizationOptions {
  /** Test seam: overrides how a region's stack outputs (incl. kubeconfig) are read. Defaults to the real Automation API path via `getRegionStackOutputs`. */
  getStackOutputsFor?: (
    regionPlan: RegionPlan,
    dnsPlan: DnsPlan,
    config: OpaqueComposeConfig,
  ) => Promise<Record<string, StackOutputValue>>;
  /** Test seam: overrides how a region's metrics client is built from its kubeconfig. Defaults to the real K8s Metrics API path via `metricsClientForRegion`. */
  metricsClientFor?: (regionPlan: RegionPlan, kubeconfigString: string) => Promise<RegionMetricsClient>;
}

const defaultGetStackOutputsFor: NonNullable<CollectUtilizationOptions["getStackOutputsFor"]> = (
  regionPlan,
  dnsPlan,
  config,
) => getRegionStackOutputs(regionPlan, dnsPlan, config as Parameters<typeof getRegionStackOutputs>[2]);

function zeroedRegionUtilization(geoId: string, observedAt: string, error: string): RegionUtilization {
  return {
    geoId,
    observedAt,
    cpuUsedCores: 0,
    cpuAllocatableCores: 0,
    cpuUtilPct: 0,
    nodeCount: 0,
    podCount: 0,
    error,
  };
}

/**
 * Collects one region's utilization. Mirrors `provisionPlan`'s per-region
 * failure isolation (`packages/provision/src/plan.ts`): any failure --
 * missing config, a stack whose outputs have no kubeconfig, an unreachable
 * cluster -- is caught here and turned into an all-zero `RegionUtilization`
 * with `error` set, never thrown, so one region's outage never blocks
 * reading the others.
 */
async function collectRegion(
  regionPlan: RegionPlan,
  plan: DeploymentPlan,
  composeConfigByGeo: Record<string, OpaqueComposeConfig>,
  vcpuPerNodeForSku: (regionPlan: RegionPlan) => number,
  opts: CollectUtilizationOptions,
  now: () => Date,
): Promise<RegionUtilization> {
  const observedAt = now().toISOString();
  try {
    if (!(regionPlan.geoId in composeConfigByGeo)) {
      throw new Error(`no ComposeConfig supplied for geoId "${regionPlan.geoId}"`);
    }
    const config = composeConfigByGeo[regionPlan.geoId];

    const getStackOutputs = opts.getStackOutputsFor ?? defaultGetStackOutputsFor;
    const outputs = await getStackOutputs(regionPlan, plan.dns, config);
    const kubeconfigValue = outputs["kubeconfig"]?.value;
    if (typeof kubeconfigValue !== "string") {
      throw new Error(`stack outputs for geoId "${regionPlan.geoId}" did not include a "kubeconfig" string output`);
    }

    const metricsClientFor = opts.metricsClientFor ?? metricsClientForRegion;
    const client = await metricsClientFor(regionPlan, kubeconfigValue);
    const sample = await client.queryUtilization();

    const nodeCount = regionPlan.nodesNeeded;
    const cpuAllocatableCores = nodeCount * vcpuPerNodeForSku(regionPlan);
    const cpuUtilPct = cpuAllocatableCores > 0 ? sample.cpuUsedCores / cpuAllocatableCores : 0;

    return {
      geoId: regionPlan.geoId,
      observedAt: sample.observedAt,
      cpuUsedCores: sample.cpuUsedCores,
      cpuAllocatableCores,
      cpuUtilPct,
      nodeCount,
      podCount: sample.podCount,
    };
  } catch (err) {
    return zeroedRegionUtilization(regionPlan.geoId, observedAt, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Produces one `UtilizationSnapshot` covering every region in `plan`. Each
 * region is collected independently -- see `collectRegion` -- so a single
 * unreachable cluster never prevents a snapshot from being written for the
 * rest.
 */
export async function collectUtilization(
  input: CollectUtilizationInput,
  opts: CollectUtilizationOptions = {},
): Promise<UtilizationSnapshot> {
  const now = input.now ?? (() => new Date());

  const regions = await Promise.all(
    input.plan.regions.map((regionPlan) =>
      collectRegion(regionPlan, input.plan, input.composeConfigByGeo, input.vcpuPerNodeForSku, opts, now),
    ),
  );

  return {
    requestId: input.plan.requestId,
    collectedAt: now().toISOString(),
    regions,
  };
}
