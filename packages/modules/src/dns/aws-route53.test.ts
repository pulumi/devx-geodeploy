import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { dnsAwsRoute53 } = await import("./aws-route53.js");

describe("dns.aws.route53", () => {
  it("constructs one latency-routed record per target endpoint", async () => {
    const out = dnsAwsRoute53("test", {
      zoneId: "Z123456",
      recordName: "api.geodeploy.example",
      routingPolicy: "latency",
      targetEndpoints: [
        { endpoint: "lb-us.example.com", routingKey: "us-east-1" },
        { endpoint: "lb-eu.example.com", routingKey: "eu-west-1" },
      ],
    });

    expect(out.records).toHaveLength(2);

    const regions = await Promise.all(
      out.records.map(
        (r) =>
          new Promise((resolve) =>
            r.latencyRoutingPolicies.apply((p) => resolve(p?.[0]?.region)),
          ),
      ),
    );
    expect(regions).toEqual(["us-east-1", "eu-west-1"]);

    const recordSetId = await new Promise((resolve) => out.recordSetId.apply(resolve));
    expect(typeof recordSetId).toBe("string");
    expect((recordSetId as string).split(",")).toHaveLength(2);
  });

  it("supports geo routing policy", async () => {
    const out = dnsAwsRoute53("test-geo", {
      zoneId: "Z123456",
      recordName: "api.geodeploy.example",
      routingPolicy: "geo",
      targetEndpoints: [{ endpoint: "lb-eu.example.com", routingKey: "DE" }],
    });

    const country = await new Promise((resolve) =>
      out.records[0]!.geolocationRoutingPolicies.apply((p) => resolve(p?.[0]?.country)),
    );
    expect(country).toBe("DE");
  });
});
