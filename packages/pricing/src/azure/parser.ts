import {
  AKS_STANDARD_SKU_NAME,
  AKS_UPTIME_SLA_METER_NAME,
  BANDWIDTH_METER_NAME,
  BANDWIDTH_PRODUCT_NAME,
  BANDWIDTH_SKU_NAME,
  LOAD_BALANCER_ARM_REGION,
  LOAD_BALANCER_METER_NAME,
  LOAD_BALANCER_SKU_NAME,
  PREMIUM_SSD_V2_METER_NAME,
  PREMIUM_SSD_V2_PRODUCT_NAME,
  PRICE_TYPE_CONSUMPTION,
  SERVICE_NAME,
} from "./constants.js";
import type { AzureRetailItem } from "./types.js";

const HOURS_PER_MONTH = 730;

/** Filter for the specific, on-demand, Linux (non-Windows) primary-region VM price for a SKU. */
export function vmFilter(region: string, armSkuName: string): string {
  return (
    `serviceName eq '${SERVICE_NAME.virtualMachines}' and armRegionName eq '${region}' ` +
    `and armSkuName eq '${armSkuName}' and priceType eq '${PRICE_TYPE_CONSUMPTION}'`
  );
}

export function findVmUsdPerHour(items: AzureRetailItem[], armSkuName: string): number | undefined {
  const match = items.find(
    (it) =>
      it.armSkuName === armSkuName &&
      it.skuName === armSkuName && // excludes " Low Priority" / " Spot" variants
      it.isPrimaryMeterRegion &&
      it.type === PRICE_TYPE_CONSUMPTION &&
      !it.productName.includes("Windows"),
  );
  return match?.retailPrice;
}

export function aksControlPlaneFilter(region: string): string {
  return `serviceName eq '${SERVICE_NAME.aks}' and armRegionName eq '${region}'`;
}

export function findAksControlPlaneUsdPerHour(items: AzureRetailItem[]): number | undefined {
  const match = items.find(
    (it) => it.skuName === AKS_STANDARD_SKU_NAME && it.meterName === AKS_UPTIME_SLA_METER_NAME,
  );
  return match?.retailPrice;
}

export function storageFilter(region: string): string {
  return `serviceName eq '${SERVICE_NAME.storage}' and armRegionName eq '${region}' and contains(productName, 'Premium SSD v2')`;
}

/** Premium SSD v2's Provisioned Capacity meter is billed per GiB-*hour*; convert to GiB-month. */
export function findBlockStorageUsdPerGiBMonth(items: AzureRetailItem[]): number | undefined {
  const match = items.find(
    (it) => it.productName === PREMIUM_SSD_V2_PRODUCT_NAME && it.meterName === PREMIUM_SSD_V2_METER_NAME,
  );
  return match ? match.retailPrice * HOURS_PER_MONTH : undefined;
}

export function bandwidthFilter(): string {
  return `serviceName eq '${SERVICE_NAME.bandwidth}' and contains(productName, 'Routing Preference: Internet')`;
}

/** First paid egress tier (the first ~100GB/month is typically free). */
export function findEgressUsdPerGiB(items: AzureRetailItem[]): number | undefined {
  const candidates = items.filter(
    (it) =>
      it.productName === BANDWIDTH_PRODUCT_NAME &&
      it.skuName === BANDWIDTH_SKU_NAME &&
      it.meterName === BANDWIDTH_METER_NAME &&
      it.retailPrice > 0,
  );
  if (candidates.length === 0) return undefined;
  const cheapestTierFirst = [...candidates].sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  return cheapestTierFirst[0]?.retailPrice;
}

export function loadBalancerFilter(): string {
  return `serviceName eq '${SERVICE_NAME.loadBalancer}' and armRegionName eq '${LOAD_BALANCER_ARM_REGION}'`;
}

export function findLoadBalancerUsdPerHour(items: AzureRetailItem[]): number | undefined {
  const match = items.find(
    (it) => it.skuName === LOAD_BALANCER_SKU_NAME && it.meterName === LOAD_BALANCER_METER_NAME,
  );
  return match?.retailPrice;
}
