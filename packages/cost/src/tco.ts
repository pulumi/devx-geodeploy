import type { CostBreakdown } from "@geodeploy/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cloud billing convention: a month is treated as 730 hours (365 * 24 / 12). */
export const HOURS_PER_MONTH = 730;

/**
 * Fraction of a node's advertised vCPU/memory that is actually schedulable by
 * pods. Every managed Kubernetes offering reserves some slice of each node
 * for the kubelet, container runtime, CNI, OS, and eviction thresholds (this
 * is exactly what EKS/GKE/AKS expose as "allocatable" vs. "capacity"). The
 * real reservation is a step function of instance size, not a flat
 * percentage, but for a v1 deterministic estimator a flat 10% headroom is a
 * reasonable, clearly-documented approximation: it slightly under-packs
 * small nodes and slightly over-reserves large ones, erring on the side of
 * *not* under-provisioning capacity.
 */
export const NODE_HEADROOM_FACTOR = 0.9;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The resources a single pod replica requests (matches WorkloadSpec.requestsPerPod). */
export interface PodResources {
  vcpu: number;
  memGiB: number;
}

/** The resource shape of a candidate node (matches the vcpu/memGiB fields of a PriceQuote). */
export interface NodeShape {
  vcpu: number;
  memGiB: number;
}

/** The per-unit prices needed to turn a node count into a full monthly bill (matches PriceQuote's price fields). */
export interface NodePricing {
  nodeUsdPerHour: number;
  controlPlaneUsdPerHour: number;
  egressUsdPerGiB: number;
  blockStorageUsdPerGiBMonth: number;
  loadBalancerUsdPerHour: number;
}

/** The workload-side quantities needed alongside NodePricing to compute a monthly bill. */
export interface WorkloadUsage {
  egressGiBPerMonth: number;
  storageGiB: number;
}

// ---------------------------------------------------------------------------
// Bin-packing math (pods-per-node, nodes-needed)
// ---------------------------------------------------------------------------

/**
 * How many pods (at the given per-pod request) fit on one node of this
 * shape, after reserving NODE_HEADROOM_FACTOR of its capacity for system
 * daemons.
 *
 * A node's usable pod density is bound by whichever resource — vCPU or
 * memory — runs out first, so this is the min of the two independent
 * per-resource densities, not their average or sum.
 */
export function podsPerNode(node: NodeShape, requestsPerPod: PodResources, headroomFactor: number = NODE_HEADROOM_FACTOR): number {
  const usableVcpu = node.vcpu * headroomFactor;
  const usableMemGiB = node.memGiB * headroomFactor;
  const byVcpu = Math.floor(usableVcpu / requestsPerPod.vcpu);
  const byMem = Math.floor(usableMemGiB / requestsPerPod.memGiB);
  return Math.max(0, Math.min(byVcpu, byMem));
}

/**
 * Number of nodes of this shape needed to host `replicas` pods at the given
 * per-pod request. Returns `Infinity` when the node cannot host even a
 * single pod under the configured headroom (e.g. a pod request larger than
 * the node itself) — callers (see binpack.ts) treat that as "this SKU is not
 * a candidate" rather than dividing by zero.
 */
export function nodesNeeded(
  replicas: number,
  node: NodeShape,
  requestsPerPod: PodResources,
  headroomFactor: number = NODE_HEADROOM_FACTOR,
): number {
  const density = podsPerNode(node, requestsPerPod, headroomFactor);
  if (density <= 0) return Infinity;
  return Math.ceil(replicas / density);
}

// ---------------------------------------------------------------------------
// Monthly cost
// ---------------------------------------------------------------------------

export interface MonthlyCostInputs extends NodePricing, WorkloadUsage {
  nodesNeeded: number;
}

export interface MonthlyCostResult {
  breakdown: CostBreakdown;
  monthlyUsd: number;
}

/**
 * Turns a resolved node count + per-unit prices into a full monthly bill.
 *
 * Simplification (documented, not hidden): egress is modeled as a single
 * flat USD/GiB rate (`egressUsdPerGiB * egressGiBPerMonth`). Real-world
 * egress pricing (AWS/GCP/Azure alike) is tiered — the marginal rate drops
 * after crossing volume thresholds (e.g. first 10TB/mo, next 40TB/mo, ...).
 * `PriceQuote` (packages/core) does not carry tier breakpoints yet, so v1
 * cannot model that curve; this is exactly the "tiered egress" risk area
 * flagged in PROJECT-PLAN.md §5.4. When PriceQuote grows tier support, this
 * is the one line that needs to change.
 */
export function computeMonthlyCost(inputs: MonthlyCostInputs): MonthlyCostResult {
  const computeUsd = inputs.nodesNeeded * inputs.nodeUsdPerHour * HOURS_PER_MONTH;
  const controlPlaneUsd = inputs.controlPlaneUsdPerHour * HOURS_PER_MONTH;
  const egressUsd = inputs.egressGiBPerMonth * inputs.egressUsdPerGiB;
  const storageUsd = inputs.storageGiB * inputs.blockStorageUsdPerGiBMonth;
  const lbUsd = inputs.loadBalancerUsdPerHour * HOURS_PER_MONTH;
  const breakdown: CostBreakdown = { computeUsd, controlPlaneUsd, egressUsd, storageUsd, lbUsd };
  const monthlyUsd = computeUsd + controlPlaneUsd + egressUsd + storageUsd + lbUsd;
  return { breakdown, monthlyUsd };
}
