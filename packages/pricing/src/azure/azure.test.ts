import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureAzureRetailPriceSource } from "./client.js";
import { getAzurePriceQuote } from "./index.js";
import {
  aksControlPlaneFilter,
  bandwidthFilter,
  findAksControlPlaneUsdPerHour,
  findBlockStorageUsdPerGiBMonth,
  findEgressUsdPerGiB,
  findLoadBalancerUsdPerHour,
  findVmUsdPerHour,
  loadBalancerFilter,
  storageFilter,
  vmFilter,
} from "./parser.js";

// Fixtures are small, trimmed, *recorded* excerpts of real Azure Retail
// Prices API responses (captured live against prices.azure.com).
const FIXTURE_DIR = fileURLToPath(new URL("../../../../test/fixtures/azure", import.meta.url));

describe("azure parser (fixture-backed)", () => {
  it("finds the Linux on-demand VM price, excluding Windows/Spot variants", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const { items } = await source.fetchItems(vmFilter("westeurope", "Standard_D2s_v5"));
    expect(findVmUsdPerHour(items, "Standard_D2s_v5")).toBeCloseTo(0.115, 6);
  });

  it("finds the AKS Standard Uptime SLA control-plane fee", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const { items } = await source.fetchItems(aksControlPlaneFilter("westeurope"));
    expect(findAksControlPlaneUsdPerHour(items)).toBeCloseTo(0.1, 6);
  });

  it("finds Premium SSD v2 storage price and converts $/GiB-hour to $/GiB-month", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const { items } = await source.fetchItems(storageFilter("westeurope"));
    // 0.00013 $/GiB/hour * 730 hours/month
    expect(findBlockStorageUsdPerGiBMonth(items)).toBeCloseTo(0.00013 * 730, 6);
  });

  it("finds the first paid egress tier, skipping the free tier", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const { items } = await source.fetchItems(bandwidthFilter());
    expect(findEgressUsdPerGiB(items)).toBeCloseTo(0.08, 6);
  });

  it("finds the Standard Load Balancer global hourly fee", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const { items } = await source.fetchItems(loadBalancerFilter());
    expect(findLoadBalancerUsdPerHour(items)).toBeCloseTo(0.025, 6);
  });

  it("throws a clear error when the manifest has no fixture for a filter", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    await expect(source.fetchItems("serviceName eq 'Nonexistent'")).rejects.toThrow(/no entry for filter/);
  });
});

describe("getAzurePriceQuote (fixture-backed)", () => {
  it("assembles a full, schema-valid PriceQuote from the fixture files", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    const quote = await getAzurePriceQuote({ region: "westeurope", armSkuName: "Standard_D2s_v5" }, { source });

    expect(quote.provider).toBe("azure");
    expect(quote.region).toBe("westeurope");
    expect(quote.sku).toBe("Standard_D2s_v5");
    expect(quote.vcpu).toBe(2);
    expect(quote.memGiB).toBe(8);
    expect(quote.arch).toBe("x86_64");
    expect(quote.nodeUsdPerHour).toBeCloseTo(0.115, 6);
    expect(quote.controlPlaneUsdPerHour).toBeCloseTo(0.1, 6);
    expect(quote.egressUsdPerGiB).toBeCloseTo(0.08, 6);
    expect(quote.blockStorageUsdPerGiBMonth).toBeCloseTo(0.00013 * 730, 6);
    expect(quote.loadBalancerUsdPerHour).toBeCloseTo(0.025, 6);
    expect(quote.currency).toBe("USD");
    expect(quote.realism).toBe("fixture");
    expect(quote.source).toContain("vm-d2sv5.json");
  });

  it("throws a clear error for a SKU without a vendored spec", async () => {
    const source = createFixtureAzureRetailPriceSource(FIXTURE_DIR);
    await expect(
      getAzurePriceQuote({ region: "westeurope", armSkuName: "Standard_Not_Real" }, { source }),
    ).rejects.toThrow(/no vendored vcpu\/memory\/arch spec/);
  });
});
