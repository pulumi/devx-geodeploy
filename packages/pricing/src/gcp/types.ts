// Cloud Billing Catalog API (`services/{serviceId}/skus`) response shape, per
// GCP's documented format. Restricted to the fields this adapter reads.

export interface GcpMoney {
  currencyCode: string;
  units: string; // whole units, as a decimal string (e.g. "0")
  nanos: number; // 1e-9 fractional units
}

export interface GcpTieredRate {
  startUsageAmount: number;
  unitPrice: GcpMoney;
}

export interface GcpPricingExpression {
  usageUnit: string;
  usageUnitDescription: string;
  baseUnit: string;
  baseUnitDescription: string;
  baseUnitConversionFactor: number;
  displayQuantity: number;
  tieredRates: GcpTieredRate[];
}

export interface GcpPricingInfo {
  effectiveTime: string;
  summary?: string;
  pricingExpression: GcpPricingExpression;
  currencyConversionRate: number;
}

export interface GcpCategory {
  serviceDisplayName: string;
  resourceFamily: string;
  resourceGroup: string;
  usageType: string; // "OnDemand" | "Preemptible" | "Commit1Mo" | ...
}

export interface GcpGeoTaxonomy {
  type: string; // "GLOBAL" | "REGIONAL" | "MULTI_REGIONAL"
  regions: string[];
}

export interface GcpSku {
  name: string;
  skuId: string;
  description: string;
  category: GcpCategory;
  serviceRegions: string[];
  pricingInfo: GcpPricingInfo[];
  serviceProviderName: string;
  geoTaxonomy?: GcpGeoTaxonomy;
}

export interface GcpSkusListResponse {
  skus: GcpSku[];
  nextPageToken: string;
}

/** `units`/`nanos` -> a plain USD number. */
export function moneyToUsd(money: GcpMoney): number {
  return Number.parseInt(money.units, 10) + money.nanos / 1e9;
}
