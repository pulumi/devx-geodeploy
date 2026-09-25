import { describe, it, expect } from "vitest";
import type * as pulumi from "@pulumi/pulumi";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { dnsNs1 } = await import("./ns1.js");

function resolveOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    output.apply((v) => {
      resolve(v);
      return v;
    });
  });
}

describe("dns.ns1", () => {
  it("constructs a single record with one answer per target endpoint", async () => {
    const out = dnsNs1("test", {
      zone: "example.com",
      recordName: "api.example.com",
      routingPolicy: "geo",
      targetEndpoints: [
        { endpoint: "lb-us.example.com", routingKey: "US" },
        { endpoint: "lb-eu.example.com", routingKey: "DE" },
      ],
    });

    const answers = await resolveOutput(out.record.answers);
    expect(answers).toHaveLength(2);
    expect(answers?.[0]?.answer).toBe("lb-us.example.com");

    const regions = await resolveOutput(out.record.regions);
    expect(regions).toHaveLength(2);
    expect(regions?.[0]?.meta?.georegion).toBe("US");

    const recordSetId = await new Promise((resolve) => out.recordSetId.apply(resolve));
    expect(typeof recordSetId).toBe("string");
  });

  it("attaches the latency filter chain for latency routing", async () => {
    const out = dnsNs1("test-latency", {
      zone: "example.com",
      recordName: "api.example.com",
      routingPolicy: "latency",
      targetEndpoints: [{ endpoint: "lb-us.example.com" }],
    });

    const filters = await resolveOutput(out.record.filters);
    expect(filters?.map((f) => f.filter)).toContain("latency");
  });
});
