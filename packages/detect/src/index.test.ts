import { describe, expect, it } from "vitest";
import { detectDnsReadiness, detectProviderReadiness } from "./index.js";

// This intentionally runs against the real, unmocked current environment (not
// process.env/fs mocks) — it documents and locks in today's actual state: no
// cloud or DNS credentials are configured anywhere on this machine. It should
// start failing the moment someone adds real credentials, which is the point.
describe("detectProviderReadiness against the real environment", () => {
  it("reports tier1: false for every compute provider today", async () => {
    const results = await detectProviderReadiness();

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.provider).sort()).toEqual(["aws", "azure", "gcp"]);
    for (const result of results) {
      expect(result.tier1).toBe(false);
      expect(result.tier2).toBeNull();
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("detectDnsReadiness against the real environment", () => {
  it("reports tier1: false for every DNS backend today", async () => {
    const results = await detectDnsReadiness();

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.provider).sort()).toEqual(["cloudflare", "ns1", "route53"]);
    for (const result of results) {
      expect(result.tier1).toBe(false);
      expect(result.tier2).toBeNull();
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});
