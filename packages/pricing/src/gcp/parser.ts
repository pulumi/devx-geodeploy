import { isCoreDescription, isRamDescription, lookupGcpMachineType, MACHINE_FAMILIES } from "./machineFamilies.js";
import { moneyToUsd, type GcpSku } from "./types.js";

function isOnDemand(sku: GcpSku): boolean {
  return sku.category.usageType === "OnDemand";
}

function servesRegion(sku: GcpSku, region: string): boolean {
  return sku.serviceRegions.includes(region) || sku.serviceRegions.includes("global");
}

/** First tier's unit price — the flat/base rate for a linearly-priced SKU. */
function baseTierUsd(sku: GcpSku): number | undefined {
  const info = sku.pricingInfo[sku.pricingInfo.length - 1]; // most recent effective pricing
  const rate = info?.pricingExpression.tieredRates.find((r) => r.startUsageAmount === 0);
  return rate ? moneyToUsd(rate.unitPrice) : undefined;
}

export interface GcpNodeFacts {
  vcpu: number;
  memGiB: number;
  arch: "x86_64" | "arm64";
  nodeUsdPerHour: number;
}

/** Sums the family's separately-billed per-vCPU-hour "Core" SKU and per-GB-hour "Ram" SKU. */
export function findNodeFacts(computeSkus: GcpSku[], region: string, machineType: string): GcpNodeFacts | undefined {
  const spec = lookupGcpMachineType(machineType);
  if (!spec) return undefined;
  const family = MACHINE_FAMILIES[spec.resourceGroup];
  if (!family) return undefined;

  const inFamily = computeSkus.filter(
    (s) => s.category.resourceGroup === spec.resourceGroup && isOnDemand(s) && servesRegion(s, region),
  );
  const coreSku = inFamily.find((s) => isCoreDescription(family, s.description));
  const ramSku = inFamily.find((s) => isRamDescription(family, s.description));
  const corePrice = coreSku ? baseTierUsd(coreSku) : undefined;
  const ramPrice = ramSku ? baseTierUsd(ramSku) : undefined;
  if (corePrice === undefined || ramPrice === undefined) return undefined;

  return {
    vcpu: spec.vcpu,
    memGiB: spec.memGiB,
    arch: spec.arch,
    nodeUsdPerHour: corePrice * spec.vcpu + ramPrice * spec.memGiB,
  };
}

/** GKE's flat per-cluster-hour management fee (Standard-tier, non-Autopilot). */
export function findGkeControlPlaneUsdPerHour(gkeSkus: GcpSku[], region: string): number | undefined {
  const sku = gkeSkus.find(
    (s) =>
      isOnDemand(s) &&
      servesRegion(s, region) &&
      s.description.toLowerCase().includes("cluster management fee"),
  );
  return sku ? baseTierUsd(sku) : undefined;
}

/** SSD persistent disk capacity, priced per GiB-month. */
export function findBlockStorageUsdPerGiBMonth(computeSkus: GcpSku[], region: string): number | undefined {
  const sku = computeSkus.find(
    (s) =>
      s.category.resourceFamily === "Storage" &&
      isOnDemand(s) &&
      servesRegion(s, region) &&
      s.description.includes("SSD backed PD Capacity"),
  );
  return sku ? baseTierUsd(sku) : undefined;
}

/** Premium-tier internet egress, first (worldwide, non-China/Australia) tier. */
export function findEgressUsdPerGiB(computeSkus: GcpSku[], region: string): number | undefined {
  const sku = computeSkus.find(
    (s) =>
      s.category.resourceFamily === "Network" &&
      isOnDemand(s) &&
      servesRegion(s, region) &&
      s.description.includes("Internet Data Transfer") &&
      s.description.includes("Americas"),
  );
  return sku ? baseTierUsd(sku) : undefined;
}

/** Forwarding-rule hourly fee for a Network Load Balancer. */
export function findLoadBalancerUsdPerHour(computeSkus: GcpSku[], region: string): number | undefined {
  const sku = computeSkus.find(
    (s) =>
      s.category.resourceGroup === "LoadBalancing" &&
      isOnDemand(s) &&
      servesRegion(s, region) &&
      s.description.includes("Forwarding Rule"),
  );
  return sku ? baseTierUsd(sku) : undefined;
}
