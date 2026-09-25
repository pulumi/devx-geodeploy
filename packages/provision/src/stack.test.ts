import { describe, expect, it, vi } from "vitest";
import type { ComposeConfig } from "@geodeploy/compose";
import type { DnsPlan, RegionPlan } from "@geodeploy/core";
import { getRegionStackOutputs, type StackOutputsLike } from "./stack.js";

function region(geoId: string, provider: "aws" | "azure" | "gcp" = "gcp"): RegionPlan {
  return {
    geoId,
    provider,
    region: "somewhere-1",
    sku: "e2-standard-4",
    centroid: { lat: 0, lon: 0 },
    demandCentroid: { lat: 0, lon: 0 },
    nodesNeeded: 2,
    monthlyUsd: 100,
    provisionable: true,
    modules: {
      cluster: `cluster.${provider}.gke`,
      registry: `registry.${provider}.ar`,
      ingress: "ingress.k8s.service-lb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.xs",
    },
  };
}

const dnsPlan: DnsPlan = { provider: null, reason: "no dns backend usable" };

const config: ComposeConfig = {
  workloadManifestFiles: ["./manifests/app.yaml"],
  ingress: { selector: { app: "demo" }, ports: [{ port: 80, targetPort: 8080 }] },
};

describe("getRegionStackOutputs", () => {
  it("reads outputs from the injected stack without ever calling preview/up", async () => {
    const outputs = vi.fn().mockResolvedValue({
      clusterName: { value: "cluster-a", secret: false },
      kubeconfig: { value: "apiVersion: v1\nkind: Config", secret: true },
    });
    const stack: StackOutputsLike = { outputs };

    const result = await getRegionStackOutputs(region("eu-central"), dnsPlan, config, { stack });

    expect(outputs).toHaveBeenCalledTimes(1);
    expect(result["kubeconfig"]?.value).toBe("apiVersion: v1\nkind: Config");
    expect(result["clusterName"]?.value).toBe("cluster-a");
  });

  it("propagates a rejection from the injected stack's outputs() call", async () => {
    const stack: StackOutputsLike = {
      outputs: vi.fn().mockRejectedValue(new Error("stack not found")),
    };

    await expect(getRegionStackOutputs(region("missing"), dnsPlan, config, { stack })).rejects.toThrow(
      /stack not found/,
    );
  });
});
