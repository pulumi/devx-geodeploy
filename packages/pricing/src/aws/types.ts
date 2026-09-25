// Shape of an AWS bulk Price List "offer file" (region-scoped index.json), as
// actually observed live for AmazonEC2 / AmazonEKS / AWSDataTransfer / AWSELB.
// This is a subset of the real format — only the fields the parser reads.

export interface AwsRegionIndex {
  formatVersion: string;
  regions: Record<string, { regionCode: string; currentVersionUrl: string }>;
}

export interface AwsProduct {
  sku: string;
  productFamily?: string;
  attributes: Record<string, string>;
}

export interface AwsPriceDimension {
  rateCode: string;
  description: string;
  beginRange?: string;
  endRange?: string;
  unit: string;
  pricePerUnit: { USD?: string };
}

export interface AwsOnDemandTerm {
  offerTermCode: string;
  sku: string;
  priceDimensions: Record<string, AwsPriceDimension>;
}

export interface AwsOfferFile {
  formatVersion: string;
  publicationDate?: string;
  products: Record<string, AwsProduct>;
  terms: {
    OnDemand?: Record<string, Record<string, AwsOnDemandTerm>>;
  };
}
