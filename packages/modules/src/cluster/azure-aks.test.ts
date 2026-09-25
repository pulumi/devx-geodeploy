import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { clusterAzureAks } = await import("./azure-aks.js");

describe("cluster.azure.aks", () => {
  it("constructs an AKS managed cluster with at least one agent pool and a decoded kubeconfig", async () => {
    const out = clusterAzureAks("test", { location: "eastus", dnsPrefix: "test-dns" });

    const agentPoolProfiles = await new Promise((resolve) => out.cluster.agentPoolProfiles.apply(resolve));
    expect(Array.isArray(agentPoolProfiles)).toBe(true);
    expect((agentPoolProfiles as unknown[]).length).toBeGreaterThanOrEqual(1);

    const kubeconfig = await new Promise<string>((resolve) => out.kubeconfig.apply(resolve));
    expect(kubeconfig).toContain("apiVersion");

    const clusterName = await new Promise((resolve) => out.clusterName.apply(resolve));
    expect(typeof clusterName).toBe("string");
  });
});
