import type { PriceQuote } from "@geodeploy/core";
import { toPriceQuote } from "../normalize.js";
import { createLiveAzureRetailPriceSource, type AzureRetailPriceSource } from "./client.js";
import {
  aksControlPlaneFilter,
  bandwidthFilter,
  findAksControlPlaneUsdPerHour,
  findBlockStorageUsdPerGiBMonth,
  findEgressUsdPerGiB,
  findLoadBalancerUsdPerHour,
  findVmUsdPerHour,
  loadBalancerFilter,
  storageFilter,
  vmFilter,
} from "./parser.js";
import { lookupAzureVmSpec } from "./vmSpecs.js";

export * from "./client.js";
export * from "./constants.js";
export * from "./parser.js";
export * from "./vmSpecs.js";
export type * from "./types.js";

export interface AzurePriceQuoteParams {
  region: string; // armRegionName, e.g. "westeurope"
  armSkuName: string; // e.g. "Standard_D2s_v5"
}

export interface AzurePriceQuoteOptions {
  source?: AzureRetailPriceSource;
}

export async function getAzurePriceQuote(
  params: AzurePriceQuoteParams,
  opts: AzurePriceQuoteOptions = {},
): Promise<PriceQuote> {
  const source = opts.source ?? createLiveAzureRetailPriceSource();
  const { region, armSkuName } = params;

  const spec = lookupAzureVmSpec(armSkuName);
  if (!spec) {
    throw new Error(`Azure: no vendored vcpu/memory/arch spec for armSkuName="${armSkuName}"`);
  }

  const [vm, aks, storage, bandwidth, lb] = await Promise.all([
    source.fetchItems(vmFilter(region, armSkuName)),
    source.fetchItems(aksControlPlaneFilter(region)),
    source.fetchItems(storageFilter(region)),
    source.fetchItems(bandwidthFilter()),
    source.fetchItems(loadBalancerFilter()),
  ]);

  const nodeUsdPerHour = findVmUsdPerHour(vm.items, armSkuName);
  const controlPlaneUsdPerHour = findAksControlPlaneUsdPerHour(aks.items);
  const blockStorageUsdPerGiBMonth = findBlockStorageUsdPerGiBMonth(storage.items);
  const egressUsdPerGiB = findEgressUsdPerGiB(bandwidth.items);
  const loadBalancerUsdPerHour = findLoadBalancerUsdPerHour(lb.items);

  const missing: string[] = [];
  if (nodeUsdPerHour === undefined) missing.push(`VM price for ${armSkuName}`);
  if (controlPlaneUsdPerHour === undefined) missing.push("AKS Uptime SLA fee");
  if (blockStorageUsdPerGiBMonth === undefined) missing.push("Premium SSD v2 price");
  if (egressUsdPerGiB === undefined) missing.push("bandwidth egress price");
  if (loadBalancerUsdPerHour === undefined) missing.push("Standard Load Balancer price");
  if (missing.length > 0) {
    throw new Error(`Azure: could not find ${missing.join(", ")} for region="${region}"`);
  }

  return toPriceQuote({
    provider: "azure",
    region,
    sku: armSkuName,
    vcpu: spec.vcpu,
    memGiB: spec.memGiB,
    arch: spec.arch,
    nodeUsdPerHour: nodeUsdPerHour as number,
    controlPlaneUsdPerHour: controlPlaneUsdPerHour as number,
    egressUsdPerGiB: egressUsdPerGiB as number,
    blockStorageUsdPerGiBMonth: blockStorageUsdPerGiBMonth as number,
    loadBalancerUsdPerHour: loadBalancerUsdPerHour as number,
    realism: source.realism,
    source: `vm=${vm.source} aks=${aks.source} storage=${storage.source} bandwidth=${bandwidth.source} lb=${lb.source}`,
  });
}
