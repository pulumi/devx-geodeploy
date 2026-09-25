import { describe, expect, it, vi } from "vitest";
import type { KubeConfig } from "@kubernetes/client-node";
import type { RegionPlan } from "@geodeploy/core";
import {
  type CustomObjectsApiLike,
  metricsClientForRegion,
  parseCpuQuantity,
  queryRegionPodMetrics,
} from "./client.js";

function region(provider: RegionPlan["provider"]): RegionPlan {
  return {
    geoId: "eu-central",
    provider,
    region: "somewhere-1",
    sku: provider === "gcp" ? "e2-standard-4" : "m6g.large",
    centroid: { lat: 0, lon: 0 },
    demandCentroid: { lat: 0, lon: 0 },
    nodesNeeded: 2,
    monthlyUsd: 100,
    provisionable: true,
    modules: {
      cluster: `cluster.${provider}.x`,
      registry: `registry.${provider}.x`,
      ingress: "ingress.k8s.service-lb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.xs",
    },
  };
}

/** Matches the shape `clusterGcpGke` (packages/modules/src/cluster/gcp-gke.ts) assembles. */
function gkeStyleKubeconfig(token: string, userName = "my-cluster"): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: userName, cluster: { server: "https://10.0.0.1", "certificate-authority-data": "ZmFrZQ==" } }],
    contexts: [{ name: userName, context: { cluster: userName, user: userName } }],
    "current-context": userName,
    users: [{ name: userName, user: { token } }],
  });
}

/** A generic (non-GCP) kubeconfig; content doesn't matter since no override is applied. */
function genericKubeconfig(): string {
  return gkeStyleKubeconfig("static-token", "my-cluster");
}

describe("parseCpuQuantity", () => {
  it.each([
    ["0", 0],
    ["1", 1],
    ["2.5", 2.5],
    ["250m", 0.25],
    ["1500m", 1.5],
    ["500000n", 0.0005],
    ["100u", 0.0001],
  ])("parses %s as %d cores", (raw, expected) => {
    expect(parseCpuQuantity(raw)).toBeCloseTo(expected, 12);
  });

  it.each(["abc", "5Gi", "1x", ""])("rejects unrecognized quantity %s", (raw) => {
    expect(() => parseCpuQuantity(raw)).toThrow(/unrecognized/i);
  });
});

describe("queryRegionPodMetrics", () => {
  it("sums per-container cpu usage and counts pods", async () => {
    const api: CustomObjectsApiLike = {
      listClusterCustomObject: vi.fn().mockResolvedValue({
        kind: "PodMetricsList",
        items: [
          { containers: [{ usage: { cpu: "250m" } }, { usage: { cpu: "100m" } }] },
          { containers: [{ usage: { cpu: "1" } }] },
        ],
      }),
    };

    const now = () => new Date("2026-09-17T00:00:00.000Z");
    const sample = await queryRegionPodMetrics(api, now);

    expect(sample.cpuUsedCores).toBeCloseTo(1.35, 12);
    expect(sample.podCount).toBe(2);
    expect(sample.observedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(api.listClusterCustomObject).toHaveBeenCalledWith({
      group: "metrics.k8s.io",
      version: "v1beta1",
      plural: "pods",
    });
  });

  it("tolerates a container with no usage.cpu (treats it as contributing 0)", async () => {
    const api: CustomObjectsApiLike = {
      listClusterCustomObject: vi.fn().mockResolvedValue({
        items: [{ containers: [{ usage: {} }, { usage: { cpu: "500m" } }] }],
      }),
    };

    const sample = await queryRegionPodMetrics(api);
    expect(sample.cpuUsedCores).toBeCloseTo(0.5, 12);
    expect(sample.podCount).toBe(1);
  });

  it("rejects when the response has no items array", async () => {
    const api: CustomObjectsApiLike = {
      listClusterCustomObject: vi.fn().mockResolvedValue({ notItems: [] }),
    };
    await expect(queryRegionPodMetrics(api)).rejects.toThrow(/items/i);
  });
});

describe("metricsClientForRegion", () => {
  it("wires a non-GCP region's kubeconfig straight into the injected CustomObjectsApi factory, without minting a token", async () => {
    const fakeApi: CustomObjectsApiLike = {
      listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    };
    const makeCustomObjectsApi = vi.fn().mockReturnValue(fakeApi);
    const mintGcpAccessToken = vi.fn();

    const client = await metricsClientForRegion(region("aws"), genericKubeconfig(), {
      makeCustomObjectsApi,
      mintGcpAccessToken,
      now: () => new Date("2026-09-17T01:00:00.000Z"),
    });

    expect(mintGcpAccessToken).not.toHaveBeenCalled();
    expect(makeCustomObjectsApi).toHaveBeenCalledTimes(1);

    const sample = await client.queryUtilization();
    expect(sample.observedAt).toBe("2026-09-17T01:00:00.000Z");
    expect(fakeApi.listClusterCustomObject).toHaveBeenCalledTimes(1);
  });

  it("for GCP, mints a fresh token and overwrites the kubeconfig's stored (stale) token before building the API client", async () => {
    const fakeApi: CustomObjectsApiLike = { listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }) };
    const mintGcpAccessToken = vi.fn().mockResolvedValue("fresh-token-123");

    let capturedToken: string | undefined;
    const makeCustomObjectsApi = vi.fn((kc: KubeConfig) => {
      capturedToken = kc.getCurrentUser()?.token;
      return fakeApi;
    });

    await metricsClientForRegion(region("gcp"), gkeStyleKubeconfig("stale-token"), {
      makeCustomObjectsApi,
      mintGcpAccessToken,
    });

    expect(mintGcpAccessToken).toHaveBeenCalledTimes(1);
    expect(capturedToken).toBe("fresh-token-123");
  });

  it("propagates a rejection from token minting for GCP regions", async () => {
    await expect(
      metricsClientForRegion(region("gcp"), gkeStyleKubeconfig("stale-token"), {
        mintGcpAccessToken: vi.fn().mockRejectedValue(new Error("no ADC available")),
        makeCustomObjectsApi: vi.fn(),
      }),
    ).rejects.toThrow(/no ADC available/);
  });

  it("rejects when the kubeconfig's current context references a user that isn't in its users list", async () => {
    const brokenKubeconfig = JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "c", cluster: { server: "https://10.0.0.1" } }],
      contexts: [{ name: "c", context: { cluster: "c", user: "ghost-user" } }],
      "current-context": "c",
      users: [],
    });

    await expect(
      metricsClientForRegion(region("gcp"), brokenKubeconfig, {
        mintGcpAccessToken: vi.fn().mockResolvedValue("fresh-token"),
        makeCustomObjectsApi: vi.fn(),
      }),
    ).rejects.toThrow(/no current user/i);
  });
});
