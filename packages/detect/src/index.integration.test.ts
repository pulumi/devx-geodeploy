import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tier1.js", () => ({
  providerTier1Checks: {
    aws: vi.fn(() => ({ tier1: true, detail: "aws present (mocked)" })),
    azure: vi.fn(() => ({ tier1: false, detail: "azure absent (mocked)" })),
    gcp: vi.fn(() => ({ tier1: true, detail: "gcp present (mocked)" })),
  },
  dnsProviderTier1Checks: {
    route53: vi.fn(() => ({ tier1: true, detail: "route53 present (mocked)" })),
    ns1: vi.fn(() => ({ tier1: false, detail: "ns1 absent (mocked)" })),
    cloudflare: vi.fn(() => ({ tier1: true, detail: "cloudflare present (mocked)" })),
  },
}));

const { mockVerifyAws, mockVerifyAzure, mockVerifyGcp, mockVerifyRoute53, mockVerifyNs1, mockVerifyCloudflare } =
  vi.hoisted(() => ({
    mockVerifyAws: vi.fn(),
    mockVerifyAzure: vi.fn(),
    mockVerifyGcp: vi.fn(),
    mockVerifyRoute53: vi.fn(),
    mockVerifyNs1: vi.fn(),
    mockVerifyCloudflare: vi.fn(),
  }));

vi.mock("./tier2.js", () => ({
  providerTier2Checks: {
    aws: mockVerifyAws,
    azure: mockVerifyAzure,
    gcp: mockVerifyGcp,
  },
  dnsProviderTier2Checks: {
    route53: mockVerifyRoute53,
    ns1: mockVerifyNs1,
    cloudflare: mockVerifyCloudflare,
  },
}));

import { resetTier2Cache, verifyDnsReadiness, verifyProviderReadiness } from "./index.js";

describe("verifyProviderReadiness", () => {
  beforeEach(() => {
    resetTier2Cache();
    mockVerifyAws.mockReset();
    mockVerifyAzure.mockReset();
    mockVerifyGcp.mockReset();
  });

  it("skips tier2 entirely for a provider that fails tier1", async () => {
    const [azureResult] = await verifyProviderReadiness(["azure"]);
    expect(azureResult).toMatchObject({ provider: "azure", tier1: false, tier2: null });
    expect(mockVerifyAzure).not.toHaveBeenCalled();
  });

  it("runs tier2 only for providers that pass tier1, and surfaces its result", async () => {
    mockVerifyAws.mockResolvedValueOnce(true);
    mockVerifyGcp.mockResolvedValueOnce(false);

    const results = await verifyProviderReadiness(["aws", "gcp"]);

    expect(results.find((r) => r.provider === "aws")).toMatchObject({ tier1: true, tier2: true });
    expect(results.find((r) => r.provider === "gcp")).toMatchObject({ tier1: true, tier2: false });
  });

  it("caches tier2 results across calls for the same provider within the process", async () => {
    mockVerifyAws.mockResolvedValueOnce(true);

    await verifyProviderReadiness(["aws"]);
    await verifyProviderReadiness(["aws"]);

    expect(mockVerifyAws).toHaveBeenCalledTimes(1);
  });
});

describe("verifyDnsReadiness", () => {
  beforeEach(() => {
    resetTier2Cache();
    mockVerifyRoute53.mockReset();
    mockVerifyNs1.mockReset();
    mockVerifyCloudflare.mockReset();
  });

  it("skips tier2 entirely for a DNS backend that fails tier1", async () => {
    const [ns1Result] = await verifyDnsReadiness(["ns1"]);
    expect(ns1Result).toMatchObject({ provider: "ns1", tier1: false, tier2: null });
    expect(mockVerifyNs1).not.toHaveBeenCalled();
  });

  it("runs tier2 for DNS backends that pass tier1, and surfaces its result", async () => {
    mockVerifyRoute53.mockResolvedValueOnce(true);
    mockVerifyCloudflare.mockResolvedValueOnce(false);

    const results = await verifyDnsReadiness(["route53", "cloudflare"]);

    expect(results.find((r) => r.provider === "route53")).toMatchObject({ tier1: true, tier2: true });
    expect(results.find((r) => r.provider === "cloudflare")).toMatchObject({ tier1: true, tier2: false });
  });
});
