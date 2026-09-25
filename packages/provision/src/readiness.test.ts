import { describe, expect, it, vi } from "vitest";
import type { DeploymentPlan } from "@geodeploy/core";

const mocks = vi.hoisted(() => ({
  verifyProviderReadiness: vi.fn(),
  verifyDnsReadiness: vi.fn(),
}));

vi.mock("@geodeploy/detect", () => ({
  verifyProviderReadiness: mocks.verifyProviderReadiness,
  verifyDnsReadiness: mocks.verifyDnsReadiness,
}));

const { checkApplyReadiness } = await import("./readiness.js");

function samplePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    requestId: "plan-1",
    createdAt: "2026-09-16T00:00:00.000Z",
    regions: [
      {
        geoId: "eu-central",
        provider: "aws",
        region: "eu-central-1",
        sku: "m6g.large",
        centroid: { lat: 50.1109, lon: 8.6821 },
        demandCentroid: { lat: 50.1109, lon: 8.6821 },
        nodesNeeded: 2,
        monthlyUsd: 100,
        provisionable: false,
        modules: {
          cluster: "cluster.aws.eks",
          registry: "registry.aws.ecr",
          ingress: "ingress.k8s.service-lb",
          autoscaling: "autoscaling.cluster-autoscaler-conservative",
          sizing: "sizing.xs",
        },
      },
    ],
    dns: { provider: null, reason: "no dns backend usable" },
    totalMonthlyUsd: 100,
    decisionRecords: [],
    allowedProviders: ["aws"],
    detectedProviders: [],
    notes: [],
    ...overrides,
  };
}

describe("checkApplyReadiness", () => {
  it("is ready when every used provider passes tier1+tier2 and dns is null", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([
      { provider: "aws", tier1: true, tier2: true, detail: "ok" },
    ]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const result = await checkApplyReadiness(samplePlan());

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(mocks.verifyDnsReadiness).not.toHaveBeenCalled();
  });

  it("reports one specific blocker per failing provider, reusing detect's detail text", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([
      {
        provider: "aws",
        tier1: false,
        tier2: null,
        detail: "checked AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE + ~/.aws/credentials or ~/.aws/config, and AWS_CONTAINER_CREDENTIALS_RELATIVE_URI — none present.",
      },
    ]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const result = await checkApplyReadiness(samplePlan());

    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("aws:");
    expect(result.blockers[0]).toContain("AWS_ACCESS_KEY_ID");
  });

  it("checks dns readiness only when the plan selected a dns provider", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([
      { provider: "aws", tier1: true, tier2: true, detail: "ok" },
    ]);
    mocks.verifyDnsReadiness.mockResolvedValue([
      { provider: "route53", tier1: true, tier2: false, detail: "tier2 identity check failed" },
    ]);

    const result = await checkApplyReadiness(samplePlan({ dns: { provider: "route53", reason: "selected route53" } }));

    expect(mocks.verifyDnsReadiness).toHaveBeenCalledWith(["route53"]);
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.startsWith("dns/route53:"))).toBe(true);
  });

  it("only asks about the distinct providers actually used in plan.regions", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([
      { provider: "aws", tier1: true, tier2: true, detail: "ok" },
      { provider: "azure", tier1: true, tier2: true, detail: "ok" },
    ]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const plan = samplePlan({
      regions: [
        { ...samplePlan().regions[0]!, geoId: "a", provider: "aws" },
        { ...samplePlan().regions[0]!, geoId: "b", provider: "aws" },
        { ...samplePlan().regions[0]!, geoId: "c", provider: "azure" },
      ],
    });

    await checkApplyReadiness(plan);

    expect(mocks.verifyProviderReadiness).toHaveBeenCalledWith(["aws", "azure"]);
  });
});
