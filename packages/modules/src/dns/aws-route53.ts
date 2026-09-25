import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type { DnsModuleArgs, DnsModuleOutputs } from "./shared.js";

export interface DnsAwsRoute53Args extends DnsModuleArgs {
  zoneId: pulumi.Input<string>;
  ttl?: number;
}

export type DnsAwsRoute53Outputs = DnsModuleOutputs & { records: aws.route53.Record[] };

/**
 * Module ID: `dns.aws.route53`
 *
 * Route53 requires one record per routing-policy member, each carrying its own
 * `setIdentifier` plus a `latencyRoutingPolicies[].region` (routingPolicy
 * "latency", where `routingKey` is an AWS region id) or a
 * `geolocationRoutingPolicies[].country` (routingPolicy "geo", where
 * `routingKey` is an ISO country code, or "*" for the default). This module
 * creates that whole record group and reports a synthetic `recordSetId`
 * (the joined per-record ids) as the shared-shape output.
 */
export function dnsAwsRoute53(
  name: string,
  args: DnsAwsRoute53Args,
  opts?: pulumi.ComponentResourceOptions,
): DnsAwsRoute53Outputs {
  const records = args.targetEndpoints.map((target, i) => {
    const setIdentifier = `${name}-${i}`;
    return new aws.route53.Record(
      `${name}-${i}`,
      {
        zoneId: args.zoneId,
        name: args.recordName,
        type: "CNAME",
        ttl: args.ttl ?? 60,
        records: [target.endpoint],
        setIdentifier,
        latencyRoutingPolicies:
          args.routingPolicy === "latency" ? [{ region: target.routingKey ?? "us-east-1" }] : undefined,
        geolocationRoutingPolicies:
          args.routingPolicy === "geo" ? [{ country: target.routingKey ?? "*" }] : undefined,
      },
      opts,
    );
  });

  const recordSetId = pulumi.all(records.map((r) => r.id)).apply((ids) => ids.join(","));

  return { records, recordSetId };
}
