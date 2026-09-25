import { describe, expect, it } from "vitest";
import { getAwsPriceQuote } from "./index.js";

// Opt-in (`pnpm test:live`): hits the real, unauthenticated AWS bulk Price
// List offer files. No credentials required. Confirmed live 2026-09-16.
describe("AWS bulk pricing (live)", () => {
  it("returns a plausible, schema-valid quote for m5.large in us-east-1", async () => {
    const quote = await getAwsPriceQuote({ region: "us-east-1", instanceType: "m5.large" });

    expect(quote.provider).toBe("aws");
    expect(quote.region).toBe("us-east-1");
    expect(quote.sku).toBeTruthy();
    expect(quote.arch).toBe("x86_64");
    expect(quote.vcpu).toBeGreaterThan(0);
    expect(quote.memGiB).toBeGreaterThan(0);
    // Sanity band rather than an exact figure — AWS revises prices over time.
    expect(quote.nodeUsdPerHour).toBeGreaterThan(0.01);
    expect(quote.nodeUsdPerHour).toBeLessThan(1);
    expect(quote.controlPlaneUsdPerHour).toBeGreaterThan(0);
    expect(quote.egressUsdPerGiB).toBeGreaterThan(0);
    expect(quote.blockStorageUsdPerGiBMonth).toBeGreaterThan(0);
    expect(quote.loadBalancerUsdPerHour).toBeGreaterThan(0);
    expect(quote.realism).toBe("live");
    expect(quote.source).toContain("pricing.us-east-1.amazonaws.com");
  }, 30_000);

  it("resolves a Graviton (arm64) instance type distinctly from x86_64", async () => {
    const quote = await getAwsPriceQuote({ region: "us-east-1", instanceType: "m6g.large" });
    expect(quote.arch).toBe("arm64");
    expect(quote.nodeUsdPerHour).toBeGreaterThan(0);
  }, 30_000);
});
