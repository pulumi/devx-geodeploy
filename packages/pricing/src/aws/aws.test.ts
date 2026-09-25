import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureAwsOfferSource } from "./client.js";
import { AWS_SERVICE_CODES } from "./constants.js";
import { getAwsPriceQuote } from "./index.js";
import {
  findBlockStorageUsdPerGiBMonth,
  findComputeInstance,
  findEgressUsdPerGiB,
  findEksControlPlaneUsdPerHour,
  findLoadBalancerUsdPerHour,
} from "./parser.js";

// Fixtures are small, trimmed, *recorded* excerpts of the real AWS bulk offer
// files (captured live against pricing.us-east-1.amazonaws.com), not hand-made data.
const FIXTURE_DIR = fileURLToPath(new URL("../../../../test/fixtures/aws", import.meta.url));

describe("aws parser (fixture-backed)", () => {
  it("finds the on-demand Linux price + specs for a Graviton instance type", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.ec2, "us-east-1");
    const facts = findComputeInstance(data, { region: "us-east-1", instanceType: "m6g.large" });
    expect(facts).toBeDefined();
    expect(facts?.vcpu).toBe(2);
    expect(facts?.memGiB).toBe(8);
    expect(facts?.arch).toBe("arm64");
    expect(facts?.nodeUsdPerHour).toBeCloseTo(0.077, 6);
  });

  it("finds the on-demand Linux price + specs for an x86_64 instance type", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.ec2, "us-east-1");
    const facts = findComputeInstance(data, { region: "us-east-1", instanceType: "m5.large" });
    expect(facts?.arch).toBe("x86_64");
    expect(facts?.nodeUsdPerHour).toBeCloseTo(0.096, 6);
  });

  it("returns undefined for an instance type not present in the offer file", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.ec2, "us-east-1");
    expect(findComputeInstance(data, { region: "us-east-1", instanceType: "not.a.real.type" })).toBeUndefined();
  });

  it("finds the gp3 EBS storage price", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.ec2, "us-east-1");
    expect(findBlockStorageUsdPerGiBMonth(data, "us-east-1")).toBeCloseTo(0.08, 6);
  });

  it("finds the EKS standard control-plane fee", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.eks, "us-east-1");
    expect(findEksControlPlaneUsdPerHour(data, "us-east-1")).toBeCloseTo(0.1, 6);
  });

  it("finds the base-tier data transfer out price", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.dataTransfer, "us-east-1");
    expect(findEgressUsdPerGiB(data, "us-east-1")).toBeCloseTo(0.09, 6);
  });

  it("finds the ALB hourly usage fee", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.elb, "us-east-1");
    expect(findLoadBalancerUsdPerHour(data, "us-east-1")).toBeCloseTo(0.0225, 6);
  });

  // Regression test: AWS prefixes `usagetype` with a per-region code in every
  // region except us-east-1 (confirmed live: eu-central-1 uses
  // "EUC1-LoadBalancerUsage", not "LoadBalancerUsage"). An earlier version of
  // findLoadBalancerUsdPerHour did an exact-string match on the unprefixed
  // name, so it silently found nothing outside us-east-1. This fixture also
  // includes the Network/Classic/Gateway variants and the decoy
  // "EUC1-TS-LoadBalancerUsage" Trust Store fee (same operation, different,
  // cheaper price) to prove the match picks the right one, not just *a* one.
  it("finds the ALB hourly usage fee in a region with a prefixed usagetype", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const { data } = await source.fetchOfferFile(AWS_SERVICE_CODES.elb, "eu-central-1");
    expect(findLoadBalancerUsdPerHour(data, "eu-central-1")).toBeCloseTo(0.027, 6);
  });
});

describe("getAwsPriceQuote (fixture-backed)", () => {
  it("assembles a full, schema-valid PriceQuote from the fixture files", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    const quote = await getAwsPriceQuote({ region: "us-east-1", instanceType: "c7g.large" }, { source });

    expect(quote.provider).toBe("aws");
    expect(quote.region).toBe("us-east-1");
    // The PriceQuote's sku is the requested instance type (human-meaningful,
    // matching Azure's armSkuName / GCP's machineType), not AWS's opaque
    // internal catalog SKU code.
    expect(quote.sku).toBe("c7g.large");
    expect(quote.arch).toBe("arm64");
    expect(quote.vcpu).toBe(2);
    expect(quote.memGiB).toBe(4);
    expect(quote.nodeUsdPerHour).toBeCloseTo(0.0725, 6);
    expect(quote.controlPlaneUsdPerHour).toBeCloseTo(0.1, 6);
    expect(quote.egressUsdPerGiB).toBeCloseTo(0.09, 6);
    expect(quote.blockStorageUsdPerGiBMonth).toBeCloseTo(0.08, 6);
    expect(quote.loadBalancerUsdPerHour).toBeCloseTo(0.0225, 6);
    expect(quote.currency).toBe("USD");
    expect(quote.realism).toBe("fixture");
    expect(quote.source).toContain("ec2-us-east-1.json");
  });

  it("throws a clear error for an instance type absent from the fixture", async () => {
    const source = createFixtureAwsOfferSource(FIXTURE_DIR);
    await expect(
      getAwsPriceQuote({ region: "us-east-1", instanceType: "does.not.exist" }, { source }),
    ).rejects.toThrow(/no on-demand Linux price/);
  });
});
