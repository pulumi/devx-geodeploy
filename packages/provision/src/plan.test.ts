import { describe, expect, it, vi } from "vitest";
import type { ComposeConfig } from "@geodeploy/compose";
import type { DeploymentPlan, RegionPlan } from "@geodeploy/core";

const mocks = vi.hoisted(() => ({
  verifyProviderReadiness: vi.fn(),
  verifyDnsReadiness: vi.fn(),
}));

vi.mock("@geodeploy/detect", () => ({
  verifyProviderReadiness: mocks.verifyProviderReadiness,
  verifyDnsReadiness: mocks.verifyDnsReadiness,
}));

const { provisionPlan } = await import("./plan.js");

function region(geoId: string, provider: "aws" | "azure" | "gcp" = "aws"): RegionPlan {
  return {
    geoId,
    provider,
    region: "somewhere-1",
    sku: "m6g.large",
    centroid: { lat: 0, lon: 0 },
    demandCentroid: { lat: 0, lon: 0 },
    nodesNeeded: 2,
    monthlyUsd: 100,
    provisionable: true,
    modules: {
      cluster: `cluster.${provider}.eks`,
      registry: `registry.${provider}.ecr`,
      ingress: "ingress.k8s.service-lb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.xs",
    },
  };
}

function samplePlan(regions: RegionPlan[]): DeploymentPlan {
  return {
    requestId: "plan-1",
    createdAt: "2026-09-16T00:00:00.000Z",
    regions,
    dns: { provider: null, reason: "no dns backend usable" },
    totalMonthlyUsd: regions.reduce((s, r) => s + r.monthlyUsd, 0),
    decisionRecords: [],
    allowedProviders: ["aws"],
    detectedProviders: [],
    notes: [],
  };
}

const config: ComposeConfig = {
  workloadManifestFiles: ["./manifests/app.yaml"],
  ingress: { selector: { app: "demo" }, ports: [{ port: 80, targetPort: 8080 }] },
};

describe("provisionPlan readiness gate", () => {
  it("refuses (throws) and never constructs a stack when readiness fails", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([
      { provider: "aws", tier1: false, tier2: null, detail: "no AWS credentials found" },
    ]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const stackFor = vi.fn();
    const plan = samplePlan([region("eu-central")]);

    await expect(provisionPlan(plan, { "eu-central": config }, { stackFor })).rejects.toThrow(/refused/i);
    expect(stackFor).not.toHaveBeenCalled();
  });
});

describe("provisionPlan orchestration", () => {
  it("provisions regions with bounded concurrency and a failed region does not affect others", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([{ provider: "aws", tier1: true, tier2: true, detail: "ok" }]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    let concurrent = 0;
    let maxConcurrent = 0;

    const stackFor = vi.fn(async (regionPlan: RegionPlan) => {
      return {
        async preview() {
          return undefined;
        },
        async up() {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent--;
          if (regionPlan.geoId === "fails") {
            throw new Error("simulated up() failure for geo 'fails'");
          }
          return { outputs: { clusterName: { value: `cluster-${regionPlan.geoId}`, secret: false } } };
        },
      };
    });

    const regions = ["a", "b", "fails", "c", "d", "e"].map((id) => region(id));
    const plan = samplePlan(regions);
    const configByGeo = Object.fromEntries(regions.map((r) => [r.geoId, config]));

    const result = await provisionPlan(plan, configByGeo, { stackFor, concurrency: 3 });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(Object.keys(result.results)).toHaveLength(6);

    expect(result.results["fails"]?.status).toBe("failed");
    expect(result.results["fails"]?.error).toContain("simulated up() failure");

    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(result.results[id]?.status).toBe("succeeded");
      expect(result.results[id]?.outputs).toEqual({ clusterName: `cluster-${id}` });
    }
  });

  it("reports live progress via onRegionOutput/onRegionStatusChange as regions provision", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([{ provider: "aws", tier1: true, tier2: true, detail: "ok" }]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const stackFor = vi.fn(async (regionPlan: RegionPlan) => ({
      async preview(opts?: { onOutput?: (chunk: string) => void }) {
        opts?.onOutput?.(`previewing ${regionPlan.geoId}`);
      },
      async up(opts?: { onOutput?: (chunk: string) => void }) {
        opts?.onOutput?.(`updating ${regionPlan.geoId}`);
        if (regionPlan.geoId === "fails") throw new Error("simulated failure");
        return { outputs: {} };
      },
    }));

    const regions = [region("ok"), region("fails")];
    const plan = samplePlan(regions);
    const configByGeo = Object.fromEntries(regions.map((r) => [r.geoId, config]));

    const outputByGeo: Record<string, string[]> = {};
    const statusByGeo: Record<string, string[]> = {};

    await provisionPlan(plan, configByGeo, {
      stackFor,
      onRegionOutput: (geoId, chunk) => {
        (outputByGeo[geoId] ??= []).push(chunk);
      },
      onRegionStatusChange: (geoId, status) => {
        (statusByGeo[geoId] ??= []).push(status);
      },
    });

    expect(outputByGeo["ok"]).toEqual(["previewing ok", "updating ok"]);
    expect(outputByGeo["fails"]).toEqual(["previewing fails", "updating fails"]);
    expect(statusByGeo["ok"]).toEqual(["running", "succeeded"]);
    expect(statusByGeo["fails"]).toEqual(["running", "failed"]);
  });

  it("marks a region failed (without affecting others) when no ComposeConfig is supplied for its geo", async () => {
    mocks.verifyProviderReadiness.mockResolvedValue([{ provider: "aws", tier1: true, tier2: true, detail: "ok" }]);
    mocks.verifyDnsReadiness.mockResolvedValue([]);

    const stackFor = vi.fn(async () => ({
      async preview() {
        return undefined;
      },
      async up() {
        return { outputs: {} };
      },
    }));

    const plan = samplePlan([region("known"), region("missing-config")]);
    const result = await provisionPlan(plan, { known: config }, { stackFor });

    expect(result.results["known"]?.status).toBe("succeeded");
    expect(result.results["missing-config"]?.status).toBe("failed");
    expect(result.results["missing-config"]?.error).toContain("missing-config");
  });
});
