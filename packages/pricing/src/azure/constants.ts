// Azure Retail Prices API. Unauthenticated, confirmed live (2026-09-16).
// Filter values are case-sensitive in this API version — 'Virtual Machines'
// works, 'virtual machines' does not — so every filter value used anywhere in
// this adapter is pinned here as an exact-cased constant, never typed inline.
export const RETAIL_PRICES_BASE_URL = "https://prices.azure.com/api/retail/prices";
export const API_VERSION = "2023-01-01-preview";

export const SERVICE_NAME = {
  virtualMachines: "Virtual Machines",
  aks: "Azure Kubernetes Service",
  storage: "Storage",
  bandwidth: "Bandwidth",
  loadBalancer: "Load Balancer",
} as const;

export const PRICE_TYPE_CONSUMPTION = "Consumption";

// AKS's flat control-plane fee is billed as the "Standard" SKU's Uptime SLA
// meter (the free tier has no Uptime SLA meter and is $0/hr).
export const AKS_STANDARD_SKU_NAME = "Standard";
export const AKS_UPTIME_SLA_METER_NAME = "Standard Uptime SLA";

// Premium SSD v2's "Provisioned Capacity" meter is a clean linear $/GiB/hour
// rate (unlike the older tiered-disk-size managed disk SKUs), so it's the
// best fit for the flat blockStorageUsdPerGiBMonth field.
export const PREMIUM_SSD_V2_PRODUCT_NAME = "Azure Premium SSD v2";
export const PREMIUM_SSD_V2_METER_NAME = "Premium LRS Provisioned Capacity";

// "Bandwidth - Routing Preference: Internet", Standard SKU, standard egress
// meter. The first ~100GB/month tier is free; we price the first paid tier.
export const BANDWIDTH_PRODUCT_NAME = "Bandwidth - Routing Preference: Internet";
export const BANDWIDTH_SKU_NAME = "Standard";
export const BANDWIDTH_METER_NAME = "Standard Data Transfer Out";

// The Standard Load Balancer's per-hour base fee is billed globally (not
// per-region) under armRegionName "Global".
export const LOAD_BALANCER_SKU_NAME = "Standard";
export const LOAD_BALANCER_METER_NAME = "Standard Included LB Rules and Outbound Rules";
export const LOAD_BALANCER_ARM_REGION = "Global";

export function retailPricesUrl(filter: string): string {
  const params = new URLSearchParams({ "api-version": API_VERSION, $filter: filter });
  return `${RETAIL_PRICES_BASE_URL}?${params.toString()}`;
}
