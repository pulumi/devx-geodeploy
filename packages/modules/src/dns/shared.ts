import * as pulumi from "@pulumi/pulumi";

/**
 * Shared DNS module shape, used across `dns.aws.route53`, `dns.ns1`, and
 * `dns.cloudflare` so the composer can treat DNS backends interchangeably.
 *
 * `routingKey` is deliberately provider-flavored (an AWS region for latency
 * policy / AWS region code or ISO country for geo policy on Route53; a
 * georegion tag on NS1) rather than forced into one universal vocabulary —
 * each real DNS provider's routing primitive genuinely differs, and papering
 * over that would misrepresent what gets provisioned. See each module's
 * doc comment for its exact interpretation.
 */
export interface DnsRecordTarget {
  endpoint: pulumi.Input<string>;
  /** Provider-specific routing hint (see module doc comment); optional. */
  routingKey?: string;
}

export interface DnsModuleArgs {
  recordName: string;
  targetEndpoints: DnsRecordTarget[];
  routingPolicy: "latency" | "geo";
}

export interface DnsModuleOutputs {
  recordSetId: pulumi.Output<string>;
}
