import { describe, expect, it } from "vitest";
import { toPriceQuote, type RawPriceFacts } from "./normalize.js";

function baseFacts(overrides: Partial<RawPriceFacts> = {}): RawPriceFacts {
  return {
    provider: "aws",
    region: "us-east-1",
    sku: "m5.large",
    vcpu: 2,
    memGiB: 8,
    arch: "x86_64",
    nodeUsdPerHour: 0.096,
    controlPlaneUsdPerHour: 0.1,
    egressUsdPerGiB: 0.09,
    blockStorageUsdPerGiBMonth: 0.08,
    loadBalancerUsdPerHour: 0.0225,
    realism: "live",
    source: "https://example.test/offer.json",
    ...overrides,
  };
}

describe("toPriceQuote", () => {
  it("stamps currency USD and validates against the shared PriceQuote schema", () => {
    const quote = toPriceQuote(baseFacts());
    expect(quote.currency).toBe("USD");
    expect(quote.provider).toBe("aws");
    expect(quote.realism).toBe("live");
    expect(typeof quote.asOf).toBe("string");
  });

  it("uses the provided asOf timestamp instead of the current time when given", () => {
    const quote = toPriceQuote(baseFacts({ asOf: "2020-01-01T00:00:00.000Z" }));
    expect(quote.asOf).toBe("2020-01-01T00:00:00.000Z");
  });

  it("rejects a negative price via the shared zod schema", () => {
    expect(() => toPriceQuote(baseFacts({ nodeUsdPerHour: -1 }))).toThrow();
  });

  it("carries the source string through unchanged, for audit", () => {
    const quote = toPriceQuote(baseFacts({ source: "fixture:/path/to/file.json" }));
    expect(quote.source).toBe("fixture:/path/to/file.json");
  });
});
