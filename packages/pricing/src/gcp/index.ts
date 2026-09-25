import type { PriceQuote } from "@geodeploy/core";
import { toPriceQuote } from "../normalize.js";
import { getDefaultGcpBillingSource, type GcpBillingSource } from "./client.js";
import { COMPUTE_ENGINE_SERVICE_ID, GKE_SERVICE_ID_UNCONFIRMED } from "./constants.js";
import {
  findBlockStorageUsdPerGiBMonth,
  findEgressUsdPerGiB,
  findGkeControlPlaneUsdPerHour,
  findLoadBalancerUsdPerHour,
  findNodeFacts,
} from "./parser.js";

export * from "./client.js";
export * from "./constants.js";
export * from "./machineFamilies.js";
export * from "./parser.js";
export type * from "./types.js";

export interface GcpPriceQuoteParams {
  region: string; // e.g. "us-central1"
  machineType: string; // e.g. "n2-standard-2"
}

export interface GcpPriceQuoteOptions {
  source?: GcpBillingSource;
}

export async function getGcpPriceQuote(
  params: GcpPriceQuoteParams,
  opts: GcpPriceQuoteOptions = {},
): Promise<PriceQuote> {
  const source = opts.source ?? getDefaultGcpBillingSource();
  const { region, machineType } = params;

  const [compute, gke] = await Promise.all([
    source.listSkus(COMPUTE_ENGINE_SERVICE_ID),
    source.listSkus(GKE_SERVICE_ID_UNCONFIRMED),
  ]);

  const node = findNodeFacts(compute.skus, region, machineType);
  if (!node) {
    throw new Error(`GCP: no Core+Ram on-demand price found for machineType="${machineType}" region="${region}"`);
  }
  const controlPlaneUsdPerHour = findGkeControlPlaneUsdPerHour(gke.skus, region);
  const blockStorageUsdPerGiBMonth = findBlockStorageUsdPerGiBMonth(compute.skus, region);
  const egressUsdPerGiB = findEgressUsdPerGiB(compute.skus, region);
  const loadBalancerUsdPerHour = findLoadBalancerUsdPerHour(compute.skus, region);

  const missing: string[] = [];
  if (controlPlaneUsdPerHour === undefined) missing.push("GKE cluster management fee");
  if (blockStorageUsdPerGiBMonth === undefined) missing.push("SSD persistent disk price");
  if (egressUsdPerGiB === undefined) missing.push("internet egress price");
  if (loadBalancerUsdPerHour === undefined) missing.push("forwarding rule price");
  if (missing.length > 0) {
    throw new Error(`GCP: could not find ${missing.join(", ")} for region="${region}"`);
  }

  return toPriceQuote({
    provider: "gcp",
    region,
    sku: machineType,
    vcpu: node.vcpu,
    memGiB: node.memGiB,
    arch: node.arch,
    nodeUsdPerHour: node.nodeUsdPerHour,
    controlPlaneUsdPerHour: controlPlaneUsdPerHour as number,
    egressUsdPerGiB: egressUsdPerGiB as number,
    blockStorageUsdPerGiBMonth: blockStorageUsdPerGiBMonth as number,
    loadBalancerUsdPerHour: loadBalancerUsdPerHour as number,
    realism: source.realism,
    source: `compute=${compute.source} gke=${gke.source}`,
  });
}
