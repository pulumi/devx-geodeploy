import type { PriceQuote, WorkloadSpec } from "@geodeploy/core";
import { describe, expect, it } from "vitest";
import { rankCandidates, type RegionPriceGroup } from "./rank.js";

function makeQuote(overrides: Partial<PriceQuote> & Pick<PriceQuote, "provider" | "region" | "sku" | "vcpu" | "memGiB" | "arch" | "nodeUsdPerHour">): PriceQuote {
  return {
    controlPlaneUsdPerHour: 0.1,
    egressUsdPerGiB: 0.09,
    blockStorageUsdPerGiBMonth: 0.08,
    loadBalancerUsdPerHour: 0.025,
    currency: "USD",
    asOf: "2026-01-01T00:00:00Z",
    realism: "fixture",
    source: "test-fixture",
    ...overrides,
  };
}

function makeWorkload(overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return {
    manifests: ["deployment.yaml"],
    replicasPerRegion: 10,
    requestsPerPod: { vcpu: 1, memGiB: 2 },
    egressGiBPerMonth: 10,
    storageGiB: 20,
    ...overrides,
  };
}

describe("rankCandidates", () => {
  it("ranks provider/region groups by monthlyUsd ascending, drops non-viable groups", () => {
    const workload = makeWorkload();

    // aws: cheapest overall via its arm64 SKU (monthlyUsd ~= 542.262, see binpack.test.ts)
    const awsX86 = makeQuote({ provider: "aws", region: "us-east-1", sku: "x86-8-16", vcpu: 8, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.384 });
    const awsArm = makeQuote({ provider: "aws", region: "us-east-1", sku: "arm-8-16", vcpu: 8, memGiB: 16, arch: "arm64", nodeUsdPerHour: 0.3072 });

    // gcp: only one, pricier SKU -> nodesNeeded=2, computeUsd=2*0.6*730=876, total=969.75
    const gcp = makeQuote({ provider: "gcp", region: "asia-east1", sku: "gcp-8-16", vcpu: 8, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.6 });

    // azure: SKU is too small for the pod request (requestsPerPod bigger than usable
    // node capacity) -> no viable SKU -> this whole group must be dropped.
    const azureTooSmall = makeQuote({ provider: "azure", region: "eu-west", sku: "tiny", vcpu: 1, memGiB: 1, arch: "x86_64", nodeUsdPerHour: 0.05 });

    const groups: RegionPriceGroup[] = [
      { provider: "aws", region: "us-east-1", centroid: { lat: 39.0438, lon: -77.4874 }, quotes: [awsX86, awsArm], distanceKm: 500, azCount: 3, gaStatus: true },
      { provider: "gcp", region: "asia-east1", centroid: { lat: 35.6762, lon: 139.6503 }, quotes: [gcp], distanceKm: 200, azCount: 2, gaStatus: false, complianceFlags: ["hipaa"] },
      { provider: "azure", region: "eu-west", centroid: { lat: 53.3498, lon: -6.2603 }, quotes: [azureTooSmall], distanceKm: 100, azCount: 3, gaStatus: true },
    ];

    const ranked = rankCandidates(workload, groups);

    // azure dropped: only 2 viable candidates
    expect(ranked).toHaveLength(2);
    expect(ranked.some((c) => c.provider === "azure")).toBe(false);

    // sorted ascending by monthlyUsd
    expect(ranked[0]!.monthlyUsd).toBeLessThan(ranked[1]!.monthlyUsd);

    // cheapest is aws via its arm64 SKU
    expect(ranked[0]).toMatchObject({
      provider: "aws",
      region: "us-east-1",
      sku: "arm-8-16",
      arch: "arm64",
      nodesNeeded: 2,
      distanceKm: 500,
      azCount: 3,
      gaStatus: true,
      complianceFlags: [],
      realism: "fixture",
      provisionable: true,
    });
    expect(ranked[0]!.monthlyUsd).toBeCloseTo(542.262, 6);

    // second is gcp, with its distance/az/compliance/GA data passed through untouched
    expect(ranked[1]).toMatchObject({
      provider: "gcp",
      region: "asia-east1",
      sku: "gcp-8-16",
      arch: "x86_64",
      nodesNeeded: 2,
      distanceKm: 200,
      azCount: 2,
      gaStatus: false,
      complianceFlags: ["hipaa"],
      provisionable: true,
    });
    expect(ranked[1]!.monthlyUsd).toBeCloseTo(969.75, 6);
  });

  it("respects an explicit provisionable: false override", () => {
    const workload = makeWorkload({ replicasPerRegion: 4, requestsPerPod: { vcpu: 0.5, memGiB: 1 } });
    const quote = makeQuote({ provider: "aws", region: "us-east-1", sku: "m1", vcpu: 4, memGiB: 8, arch: "x86_64", nodeUsdPerHour: 0.1 });

    const ranked = rankCandidates(workload, [
      { provider: "aws", region: "us-east-1", centroid: { lat: 39.0438, lon: -77.4874 }, quotes: [quote], distanceKm: 10, azCount: 1, gaStatus: true, provisionable: false },
    ]);

    expect(ranked[0]!.provisionable).toBe(false);
  });

  it("returns an empty array when every group is non-viable", () => {
    const workload = makeWorkload({ requestsPerPod: { vcpu: 1000, memGiB: 1000 } });
    const quote = makeQuote({ provider: "aws", region: "us-east-1", sku: "m1", vcpu: 4, memGiB: 8, arch: "x86_64", nodeUsdPerHour: 0.1 });

    const ranked = rankCandidates(workload, [{ provider: "aws", region: "us-east-1", centroid: { lat: 39.0438, lon: -77.4874 }, quotes: [quote], distanceKm: 10, azCount: 1, gaStatus: true }]);

    expect(ranked).toEqual([]);
  });

  it("drops a group whose only SKU is an architecture the image was never built for", () => {
    const workload = makeWorkload();
    const armOnly = makeQuote({ provider: "gcp", region: "asia-east1", sku: "arm-only", vcpu: 8, memGiB: 16, arch: "arm64", nodeUsdPerHour: 0.3 });
    const x86Ok = makeQuote({ provider: "aws", region: "us-east-1", sku: "x86-ok", vcpu: 8, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.4 });

    const groups: RegionPriceGroup[] = [
      { provider: "gcp", region: "asia-east1", centroid: { lat: 35.6762, lon: 139.6503 }, quotes: [armOnly], distanceKm: 200, azCount: 2, gaStatus: true },
      { provider: "aws", region: "us-east-1", centroid: { lat: 39.0438, lon: -77.4874 }, quotes: [x86Ok], distanceKm: 500, azCount: 3, gaStatus: true },
    ];

    // An image built only for linux/amd64 must exclude the arm64-only gcp group entirely.
    const ranked = rankCandidates(workload, groups, undefined, ["x86_64"]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.provider).toBe("aws");
  });
});
