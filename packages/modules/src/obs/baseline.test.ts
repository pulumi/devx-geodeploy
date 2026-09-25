import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { obsK8sBaseline } = await import("./baseline.js");

describe("obs.k8s.baseline", () => {
  it("constructs a namespaced daemonset with an otel collector and node exporter container", async () => {
    const out = obsK8sBaseline("test", {});

    const spec = await new Promise<{ template: { spec: { containers: Array<{ name: string }> } } }>((resolve) =>
      out.daemonSet.spec.apply(resolve),
    );
    const containerNames = spec.template.spec.containers.map((c) => c.name);
    expect(containerNames).toEqual(["otel-collector", "prometheus-node-exporter"]);

    const namespaceName = await new Promise((resolve) => out.namespace.metadata.apply((m) => resolve(m.name)));
    expect(namespaceName).toBe("geodeploy-observability");
  });
});
