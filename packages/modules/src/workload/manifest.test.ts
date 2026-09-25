import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { workloadK8sManifest } = await import("./manifest.js");

const fixture = fileURLToPath(new URL("./fixtures/deployment.yaml", import.meta.url));

describe("workload.k8s.manifest", () => {
  it("applies the user's manifest files via yaml.v2.ConfigGroup", async () => {
    const out = workloadK8sManifest("test", { files: [fixture] });

    const urn = await new Promise((resolve) => out.configGroup.urn.apply(resolve));
    expect(typeof urn).toBe("string");
    expect(urn).toContain("kubernetes:yaml/v2:ConfigGroup");
  });
});
