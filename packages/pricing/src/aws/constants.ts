// AWS bulk Price List "offer file" endpoints. Unauthenticated, confirmed live
// (2026-09-16) for these four service codes. There is deliberately no
// "AmazonEBS" service — EBS/storage pricing lives inside the AmazonEC2 offer
// file, distinguished by `productFamily`, not a separate bulk file (confirmed:
// AmazonEBS/current/region_index.json 404s).
export const PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";

export const AWS_SERVICE_CODES = {
  ec2: "AmazonEC2",
  eks: "AmazonEKS",
  dataTransfer: "AWSDataTransfer",
  elb: "AWSELB",
} as const;

export type AwsServiceCode = (typeof AWS_SERVICE_CODES)[keyof typeof AWS_SERVICE_CODES];

export function regionIndexUrl(serviceCode: AwsServiceCode): string {
  return `${PRICING_HOST}/offers/v1.0/aws/${serviceCode}/current/region_index.json`;
}

export function offerFileUrl(currentVersionUrl: string): string {
  // currentVersionUrl in region_index.json is host-relative, e.g.
  // "/offers/v1.0/aws/AmazonEKS/20260911124427/us-east-1/index.json".
  return currentVersionUrl.startsWith("http") ? currentVersionUrl : `${PRICING_HOST}${currentVersionUrl}`;
}
