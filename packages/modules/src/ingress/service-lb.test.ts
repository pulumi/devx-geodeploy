import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { ingressK8sServiceLb } = await import("./service-lb.js");

describe("ingress.k8s.service-lb", () => {
  it("constructs a type=LoadBalancer Service and resolves an external endpoint", async () => {
    const out = ingressK8sServiceLb("test", {
      selector: { app: "api" },
      ports: [{ port: 80, targetPort: 8080 }],
    });

    const spec = await new Promise<{ type: string }>((resolve) => out.service.spec.apply(resolve));
    expect(spec.type).toBe("LoadBalancer");

    const endpoint = await new Promise((resolve) => out.externalEndpoint.apply(resolve));
    expect(endpoint).toBe("203.0.113.10");
  });
});
