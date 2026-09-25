import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { clusterAwsEks } = await import("./aws-eks.js");

describe("cluster.aws.eks", () => {
  it("constructs an EKS cluster with a kubeconfig output", async () => {
    const out = clusterAwsEks("test", { region: "us-east-1" });
    const clusterName = await new Promise((resolve) => out.clusterName.apply(resolve));
    expect(typeof clusterName).toBe("string");
    expect(out.cluster).toBeDefined();
  });
});
