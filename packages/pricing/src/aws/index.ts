import type { PriceQuote } from "@geodeploy/core";
import { toPriceQuote } from "../normalize.js";
import { createLiveAwsOfferSource, type AwsOfferSource } from "./client.js";
import { AWS_SERVICE_CODES } from "./constants.js";
import {
  findBlockStorageUsdPerGiBMonth,
  findComputeInstance,
  findEgressUsdPerGiB,
  findEksControlPlaneUsdPerHour,
  findLoadBalancerUsdPerHour,
} from "./parser.js";

export * from "./client.js";
export * from "./constants.js";
export * from "./parser.js";
export type * from "./types.js";

export interface AwsPriceQuoteParams {
  region: string;
  instanceType: string;
}

export interface AwsPriceQuoteOptions {
  source?: AwsOfferSource;
}

/**
 * Builds a full `PriceQuote` for an EC2 instance type in a region by pulling
 * (and, live, caching) four AWS bulk offer files: AmazonEC2 (node compute +
 * gp3 EBS storage), AmazonEKS (control-plane fee), AWSDataTransfer (egress),
 * AWSELB (load balancer).
 */
export async function getAwsPriceQuote(
  params: AwsPriceQuoteParams,
  opts: AwsPriceQuoteOptions = {},
): Promise<PriceQuote> {
  const source = opts.source ?? createLiveAwsOfferSource();
  const { region, instanceType } = params;

  const [ec2, eks, dataTransfer, elb] = await Promise.all([
    source.fetchOfferFile(AWS_SERVICE_CODES.ec2, region),
    source.fetchOfferFile(AWS_SERVICE_CODES.eks, region),
    source.fetchOfferFile(AWS_SERVICE_CODES.dataTransfer, region),
    source.fetchOfferFile(AWS_SERVICE_CODES.elb, region),
  ]);

  const compute = findComputeInstance(ec2.data, { region, instanceType });
  if (!compute) {
    throw new Error(`AWS: no on-demand Linux price found for instanceType="${instanceType}" region="${region}"`);
  }
  const blockStorageUsdPerGiBMonth = findBlockStorageUsdPerGiBMonth(ec2.data, region);
  const controlPlaneUsdPerHour = findEksControlPlaneUsdPerHour(eks.data, region);
  const egressUsdPerGiB = findEgressUsdPerGiB(dataTransfer.data, region);
  const loadBalancerUsdPerHour = findLoadBalancerUsdPerHour(elb.data, region);

  const missing: string[] = [];
  if (blockStorageUsdPerGiBMonth === undefined) missing.push("gp3 EBS storage price");
  if (controlPlaneUsdPerHour === undefined) missing.push("EKS control-plane fee");
  if (egressUsdPerGiB === undefined) missing.push("data-transfer-out price");
  if (loadBalancerUsdPerHour === undefined) missing.push("ALB hourly price");
  if (missing.length > 0) {
    throw new Error(`AWS: could not find ${missing.join(", ")} for region="${region}"`);
  }

  return toPriceQuote({
    provider: "aws",
    region,
    // The requested instance type, not AWS's opaque internal catalog SKU
    // code (compute.sku) — every other provider's PriceQuote.sku is a
    // human-meaningful identifier (e.g. Azure's "Standard_D8ps_v5"), and
    // downstream consumers (reports, CLI tables, decision records) render
    // this field expecting that.
    sku: instanceType,
    vcpu: compute.vcpu,
    memGiB: compute.memGiB,
    arch: compute.arch,
    nodeUsdPerHour: compute.nodeUsdPerHour,
    // Non-null: presence already checked above via `missing`.
    controlPlaneUsdPerHour: controlPlaneUsdPerHour as number,
    egressUsdPerGiB: egressUsdPerGiB as number,
    blockStorageUsdPerGiBMonth: blockStorageUsdPerGiBMonth as number,
    loadBalancerUsdPerHour: loadBalancerUsdPerHour as number,
    realism: source.realism,
    source: `ec2=${ec2.source} eks=${eks.source} dataTransfer=${dataTransfer.source} elb=${elb.source}`,
  });
}
