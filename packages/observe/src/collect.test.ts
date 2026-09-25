import { describe, expect, it, vi } from "vitest";
import type { DeploymentPlan, DnsPlan, RegionPlan } from "@geodeploy/core";
import type { StackOutputValue } from "@geodeploy/provision";
import { collectUtilization } from "./collect.js";
import type { RegionMetricsClient } from "./client.js";

function region(geoId: string, nodesNeeded = 2): RegionPlan {
  return {
    geoId,
    provider: "aws",
    region: "somewhere-1",
    sku: "m6g.large",
    centroid: { lat: 0, lon: 0 },
    demandCentroid: { lat: 0, lon: 0 },
    nodesNeeded,
    monthlyUsd: 100,
    provisionable: true,
    modules: {
      cluster: "cluster.aws.eks",
      registry: "registry.aws.ecr",
      ingress: "ingress.k8s.service-lb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.xs",
    },
  };
}

const dnsPlan: DnsPlan = { provider: null, reason: "no dns backend usable" };

function plan(regions: RegionPlan[]): DeploymentPlan {
  return {
    requestId: "plan-1",
    createdAt: "2026-09-16T00:00:00.000Z",
    regions,
    dns: dnsPlan,
    totalMonthlyUsd: regions.reduce((s, r) => s + r.monthlyUsd, 0),
    decisionRecords: [],
    allowedProviders: ["aws"],
    detectedProviders: [],
    notes: [],
  };
}

// `OpaqueComposeConfig` is `unknown` from @geodeploy/observe's point of view (see
// collect.ts's comment); its exact shape only matters to @geodeploy/compose/@geodeploy/provision.
const composeConfig = {
  workloadManifestFiles: ["./manifests/app.yaml"],
  ingress: { selector: { app: "demo" }, ports: [{ port: 80, targetPort: 8080 }] },
};

function outputsWithKubeconfig(kubeconfig: string): Record<string, StackOutputValue> {
  return { kubeconfig: { value: kubeconfig, secret: true } };
}

function clientReturning(cpuUsedCores: number, podCount: number): RegionMetricsClient {
  return {
    queryUtilization: vi.fn().mockResolvedValue({
      observedAt: "2026-09-17T00:00:00.000Z",
      cpuUsedCores,
      podCount,
    }),
  };
}

const now = () => new Date("2026-09-17T00:05:00.000Z");

describe("collectUtilization", () => {
  it("assembles a snapshot with correct cpuAllocatableCores/cpuUtilPct math across regions", async () => {
    const p = plan([region("eu-central", 2), region("us-east", 4)]);

    const getStackOutputsFor = vi.fn(async (regionPlan: RegionPlan) =>
      outputsWithKubeconfig(`kubeconfig-for-${regionPlan.geoId}`),
    );
    const metricsClientFor = vi.fn(async (regionPlan: RegionPlan) =>
      regionPlan.geoId === "eu-central" ? clientReturning(1.5, 3) : clientReturning(0.5, 1),
    );

    const snapshot = await collectUtilization(
      {
        plan: p,
        composeConfigByGeo: { "eu-central": composeConfig, "us-east": composeConfig },
        vcpuPerNodeForSku: () => 2,
        now,
      },
      { getStackOutputsFor, metricsClientFor },
    );

    expect(snapshot.requestId).toBe("plan-1");
    expect(snapshot.collectedAt).toBe("2026-09-17T00:05:00.000Z");
    expect(snapshot.regions).toHaveLength(2);

    const euCentral = snapshot.regions.find((r) => r.geoId === "eu-central")!;
    expect(euCentral.cpuAllocatableCores).toBe(4); // 2 nodes * 2 vcpu
    expect(euCentral.cpuUsedCores).toBe(1.5);
    expect(euCentral.cpuUtilPct).toBeCloseTo(0.375, 12);
    expect(euCentral.podCount).toBe(3);
    expect(euCentral.nodeCount).toBe(2);
    expect(euCentral.error).toBeUndefined();

    const usEast = snapshot.regions.find((r) => r.geoId === "us-east")!;
    expect(usEast.cpuAllocatableCores).toBe(8); // 4 nodes * 2 vcpu
    expect(usEast.cpuUtilPct).toBeCloseTo(0.0625, 12);
  });

  it("isolates a per-region failure (stack outputs error) without affecting other regions", async () => {
    const p = plan([region("broken"), region("healthy")]);

    const getStackOutputsFor = vi.fn(async (regionPlan: RegionPlan) => {
      if (regionPlan.geoId === "broken") throw new Error("stack not found");
      return outputsWithKubeconfig("kubeconfig-healthy");
    });
    const metricsClientFor = vi.fn(async () => clientReturning(1, 2));

    const snapshot = await collectUtilization(
      {
        plan: p,
        composeConfigByGeo: { broken: composeConfig, healthy: composeConfig },
        vcpuPerNodeForSku: () => 4,
        now,
      },
      { getStackOutputsFor, metricsClientFor },
    );

    const broken = snapshot.regions.find((r) => r.geoId === "broken")!;
    expect(broken.error).toContain("stack not found");
    expect(broken.cpuUsedCores).toBe(0);
    expect(broken.cpuAllocatableCores).toBe(0);
    expect(broken.cpuUtilPct).toBe(0);
    expect(broken.nodeCount).toBe(0);
    expect(broken.podCount).toBe(0);

    const healthy = snapshot.regions.find((r) => r.geoId === "healthy")!;
    expect(healthy.error).toBeUndefined();
    expect(healthy.cpuAllocatableCores).toBe(8);
  });

  it("records an error when no ComposeConfig was supplied for a region's geoId", async () => {
    const p = plan([region("no-config")]);

    const snapshot = await collectUtilization({
      plan: p,
      composeConfigByGeo: {},
      vcpuPerNodeForSku: () => 4,
      now,
    });

    expect(snapshot.regions[0]?.error).toContain("no ComposeConfig supplied");
  });

  it("records an error when stack outputs have no kubeconfig string", async () => {
    const p = plan([region("no-kubeconfig")]);

    const snapshot = await collectUtilization(
      {
        plan: p,
        composeConfigByGeo: { "no-kubeconfig": composeConfig },
        vcpuPerNodeForSku: () => 4,
        now,
      },
      {
        getStackOutputsFor: async () => ({ clusterName: { value: "c", secret: false } }),
      },
    );

    expect(snapshot.regions[0]?.error).toMatch(/kubeconfig/i);
  });

  it("records an error when the metrics client rejects", async () => {
    const p = plan([region("unreachable")]);

    const snapshot = await collectUtilization(
      {
        plan: p,
        composeConfigByGeo: { unreachable: composeConfig },
        vcpuPerNodeForSku: () => 4,
        now,
      },
      {
        getStackOutputsFor: async () => outputsWithKubeconfig("kc"),
        metricsClientFor: async () => {
          throw new Error("connection refused");
        },
      },
    );

    expect(snapshot.regions[0]?.error).toContain("connection refused");
  });

  it("never divides by zero when cpuAllocatableCores is 0", async () => {
    const p = plan([region("zero-nodes", 0)]);

    const snapshot = await collectUtilization(
      {
        plan: p,
        composeConfigByGeo: { "zero-nodes": composeConfig },
        vcpuPerNodeForSku: () => 4,
        now,
      },
      {
        getStackOutputsFor: async () => outputsWithKubeconfig("kc"),
        metricsClientFor: async () => clientReturning(0.1, 1),
      },
    );

    expect(snapshot.regions[0]?.cpuAllocatableCores).toBe(0);
    expect(snapshot.regions[0]?.cpuUtilPct).toBe(0);
  });
});
