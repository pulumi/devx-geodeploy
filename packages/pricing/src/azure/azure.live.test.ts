import { describe, expect, it } from "vitest";
import { getAzurePriceQuote } from "./index.js";

// Opt-in (`pnpm test:live`): hits the real, unauthenticated Azure Retail
// Prices API. No credentials required. Confirmed live 2026-09-16.
describe("Azure Retail Prices (live)", () => {
  it("returns a plausible, schema-valid quote for Standard_D2s_v5 in westeurope", async () => {
    const quote = await getAzurePriceQuote({ region: "westeurope", armSkuName: "Standard_D2s_v5" });

    expect(quote.provider).toBe("azure");
    expect(quote.region).toBe("westeurope");
    expect(quote.sku).toBe("Standard_D2s_v5");
    expect(quote.arch).toBe("x86_64");
    expect(quote.vcpu).toBe(2);
    expect(quote.memGiB).toBe(8);
    // Sanity band rather than an exact figure — Azure revises prices over time.
    expect(quote.nodeUsdPerHour).toBeGreaterThan(0.01);
    expect(quote.nodeUsdPerHour).toBeLessThan(1);
    expect(quote.controlPlaneUsdPerHour).toBeGreaterThan(0);
    expect(quote.egressUsdPerGiB).toBeGreaterThan(0);
    expect(quote.blockStorageUsdPerGiBMonth).toBeGreaterThan(0);
    expect(quote.loadBalancerUsdPerHour).toBeGreaterThan(0);
    expect(quote.realism).toBe("live");
    expect(quote.source).toContain("prices.azure.com");
  }, 30_000);

  it("resolves an Azure Cobalt/Ampere (arm64) VM SKU distinctly from x86_64", async () => {
    const quote = await getAzurePriceQuote({ region: "westeurope", armSkuName: "Standard_D2ps_v5" });
    expect(quote.arch).toBe("arm64");
    expect(quote.nodeUsdPerHour).toBeGreaterThan(0);
  }, 30_000);
});
