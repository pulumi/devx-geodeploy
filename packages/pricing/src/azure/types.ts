// Fields actually observed live from the Azure Retail Prices API
// (2023-01-01-preview), restricted to what the parser reads.
export interface AzureRetailItem {
  currencyCode: string;
  tierMinimumUnits: number;
  retailPrice: number;
  unitPrice: number;
  armRegionName: string;
  location: string;
  meterId: string;
  meterName: string;
  productId: string;
  skuId: string;
  productName: string;
  skuName: string;
  serviceName: string;
  serviceId: string;
  serviceFamily: string;
  unitOfMeasure: string;
  type: string;
  isPrimaryMeterRegion: boolean;
  armSkuName: string;
}

export interface AzureRetailPricesPage {
  BillingCurrency: string;
  Items: AzureRetailItem[];
  NextPageLink: string | null;
  Count: number;
}
