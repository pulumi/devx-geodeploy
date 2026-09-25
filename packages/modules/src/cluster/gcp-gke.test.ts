import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { clusterGcpGke } = await import("./gcp-gke.js");

describe("cluster.gcp.gke", () => {
  it("constructs a GKE cluster and assembles a kubeconfig from endpoint + masterAuth", async () => {
    const out = clusterGcpGke("test", { location: "us-central1", initialNodeCount: 3 });

    const kubeconfig = await new Promise<string>((resolve) => out.kubeconfig.apply(resolve));
    const parsed = JSON.parse(kubeconfig);
    expect(parsed.clusters[0].cluster.server).toContain("https://");
    expect(parsed.users[0].user.token).toBe("fake-gcp-access-token");

    const clusterName = await new Promise((resolve) => out.clusterName.apply(resolve));
    expect(typeof clusterName).toBe("string");
  });

  it("supports enableAutopilot", async () => {
    const out = clusterGcpGke("test-autopilot", { location: "us-central1", enableAutopilot: true });
    const enableAutopilot = await new Promise((resolve) => out.cluster.enableAutopilot.apply(resolve));
    expect(enableAutopilot).toBe(true);
  });
});
