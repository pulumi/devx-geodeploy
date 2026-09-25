import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureGcpBillingSource, getDefaultGcpBillingSource } from "./client.js";
import { COMPUTE_ENGINE_SERVICE_ID, GKE_SERVICE_ID_UNCONFIRMED } from "./constants.js";
import { getGcpPriceQuote } from "./index.js";
import {
  findBlockStorageUsdPerGiBMonth,
  findEgressUsdPerGiB,
  findGkeControlPlaneUsdPerHour,
  findLoadBalancerUsdPerHour,
  findNodeFacts,
} from "./parser.js";

// GCP requires an API key/OAuth for the Cloud Billing Catalog API — there is
// no public unauthenticated bulk equivalent like AWS/Azure have (confirmed:
// an unauthenticated probe against cloudbilling.googleapis.com 403s). These
// fixtures are hand-built to match the real, documented response shape
// exactly (serviceRegions[], category, geoTaxonomy, pricingInfo[].pricingExpression
// with tieredRates as startUsageAmount + unitPrice.units/nanos), not recorded.
const FIXTURE_DIR = fileURLToPath(new URL("../../../../test/fixtures/gcp", import.meta.url));

describe("gcp parser (fixture-backed)", () => {
  it("sums the Core + Ram SKUs for an x86_64 (N2) machine type", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    const facts = findNodeFacts(skus, "us-central1", "n2-standard-2");
    expect(facts).toBeDefined();
    expect(facts?.arch).toBe("x86_64");
    expect(facts?.vcpu).toBe(2);
    expect(facts?.memGiB).toBe(8);
    // 2 vCPU * 0.031611 + 8 GiB * 0.004237
    expect(facts?.nodeUsdPerHour).toBeCloseTo(2 * 0.031611 + 8 * 0.004237, 9);
  });

  it("sums the Core + Ram SKUs for an arm64 (T2A/Ampere) machine type", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    const facts = findNodeFacts(skus, "us-central1", "t2a-standard-2");
    expect(facts?.arch).toBe("arm64");
    expect(facts?.nodeUsdPerHour).toBeCloseTo(2 * 0.023377 + 8 * 0.0031333, 9);
  });

  it("returns undefined for a machine type with no vendored spec", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    expect(findNodeFacts(skus, "us-central1", "not-a-real-type")).toBeUndefined();
  });

  it("finds the GKE cluster management fee", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(GKE_SERVICE_ID_UNCONFIRMED);
    expect(findGkeControlPlaneUsdPerHour(skus, "us-central1")).toBeCloseTo(0.1, 9);
  });

  it("finds SSD persistent disk storage price", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    expect(findBlockStorageUsdPerGiBMonth(skus, "us-central1")).toBeCloseTo(0.17, 9);
  });

  it("finds the base-tier internet egress price", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    expect(findEgressUsdPerGiB(skus, "us-central1")).toBeCloseTo(0.12, 9);
  });

  it("finds the forwarding-rule load balancer hourly price", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const { skus } = await source.listSkus(COMPUTE_ENGINE_SERVICE_ID);
    expect(findLoadBalancerUsdPerHour(skus, "us-central1")).toBeCloseTo(0.025, 9);
  });
});

describe("getGcpPriceQuote (fixture-backed)", () => {
  it("assembles a full, schema-valid PriceQuote from the fixture files", async () => {
    const source = createFixtureGcpBillingSource(FIXTURE_DIR);
    const quote = await getGcpPriceQuote({ region: "us-central1", machineType: "n2-standard-2" }, { source });

    expect(quote.provider).toBe("gcp");
    expect(quote.region).toBe("us-central1");
    expect(quote.sku).toBe("n2-standard-2");
    expect(quote.vcpu).toBe(2);
    expect(quote.memGiB).toBe(8);
    expect(quote.arch).toBe("x86_64");
    expect(quote.controlPlaneUsdPerHour).toBeCloseTo(0.1, 9);
    expect(quote.blockStorageUsdPerGiBMonth).toBeCloseTo(0.17, 9);
    expect(quote.egressUsdPerGiB).toBeCloseTo(0.12, 9);
    expect(quote.loadBalancerUsdPerHour).toBeCloseTo(0.025, 9);
    expect(quote.currency).toBe("USD");
    expect(quote.realism).toBe("fixture");
    expect(quote.source).toContain("6F81-5844-456A.json");
  });

  it("defaults to the fixture source when no GOOGLE_API_KEY is set", async () => {
    const originalKey = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    try {
      const source = getDefaultGcpBillingSource();
      expect(source.realism).toBe("fixture");
      const quote = await getGcpPriceQuote({ region: "us-central1", machineType: "t2a-standard-2" });
      expect(quote.realism).toBe("fixture");
      expect(quote.arch).toBe("arm64");
    } finally {
      if (originalKey !== undefined) process.env["GOOGLE_API_KEY"] = originalKey;
    }
  });

  it("switches to the live client the moment GOOGLE_API_KEY is set, with no other code change", () => {
    const originalKey = process.env["GOOGLE_API_KEY"];
    process.env["GOOGLE_API_KEY"] = "test-key-not-a-real-credential";
    try {
      const source = getDefaultGcpBillingSource();
      expect(source.realism).toBe("live");
    } finally {
      if (originalKey === undefined) delete process.env["GOOGLE_API_KEY"];
      else process.env["GOOGLE_API_KEY"] = originalKey;
    }
  });
});
