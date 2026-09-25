import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { dnsCloudflare } = await import("./cloudflare.js");

describe("dns.cloudflare", () => {
  it("constructs a LoadBalancerPool with one origin per target endpoint and a LoadBalancer over it", async () => {
    const out = dnsCloudflare("test", {
      zoneId: "zone-123",
      accountId: "acct-123",
      recordName: "api.example.com",
      routingPolicy: "latency",
      targetEndpoints: [{ endpoint: "lb-us.example.com" }, { endpoint: "lb-eu.example.com" }],
    });

    const origins = await new Promise<Array<{ address?: string }>>((resolve) => out.pool.origins.apply(resolve));
    expect(origins).toHaveLength(2);
    expect(origins.map((o) => o.address)).toEqual(["lb-us.example.com", "lb-eu.example.com"]);

    const steeringPolicy = await new Promise((resolve) => out.loadBalancer.steeringPolicy.apply(resolve));
    expect(steeringPolicy).toBe("dynamic_latency");

    const recordSetId = await new Promise((resolve) => out.recordSetId.apply(resolve));
    expect(typeof recordSetId).toBe("string");
  });

  it("uses steeringPolicy geo for geo routing", async () => {
    const out = dnsCloudflare("test-geo", {
      zoneId: "zone-123",
      accountId: "acct-123",
      recordName: "api.example.com",
      routingPolicy: "geo",
      targetEndpoints: [{ endpoint: "lb-eu.example.com" }],
    });

    const steeringPolicy = await new Promise((resolve) => out.loadBalancer.steeringPolicy.apply(resolve));
    expect(steeringPolicy).toBe("geo");
  });
});
