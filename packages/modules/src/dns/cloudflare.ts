import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import type { DnsModuleArgs, DnsModuleOutputs } from "./shared.js";

export interface DnsCloudflareArgs extends DnsModuleArgs {
  zoneId: pulumi.Input<string>;
  accountId: pulumi.Input<string>;
}

export type DnsCloudflareOutputs = DnsModuleOutputs & {
  pool: cloudflare.LoadBalancerPool;
  loadBalancer: cloudflare.LoadBalancer;
};

/**
 * Module ID: `dns.cloudflare`
 *
 * Cloudflare's DNS-level steering primitive is `LoadBalancer` +
 * `LoadBalancerPool` (a plain `DnsRecord` only ever points at one target), so
 * this module builds a pool containing every target endpoint as a pool
 * origin, then a load balancer over it with `steeringPolicy` set from
 * `routingPolicy` ("geo" -> "geo", "latency" -> "dynamic_latency").
 * `routingKey` per target is not required by Cloudflare's own steering (it
 * infers latency/geo from real traffic and pool metadata), so it is unused
 * here — noted as the one deliberate deviation from the shared shape.
 */
export function dnsCloudflare(
  name: string,
  args: DnsCloudflareArgs,
  opts?: pulumi.ComponentResourceOptions,
): DnsCloudflareOutputs {
  const pool = new cloudflare.LoadBalancerPool(
    `${name}-pool`,
    {
      accountId: args.accountId,
      name: `${name}-pool`,
      origins: args.targetEndpoints.map((target, i) => ({
        name: `${name}-origin-${i}`,
        address: target.endpoint,
        enabled: true,
      })),
    },
    opts,
  );

  const loadBalancer = new cloudflare.LoadBalancer(
    name,
    {
      zoneId: args.zoneId,
      name: args.recordName,
      defaultPools: [pool.id],
      fallbackPool: pool.id,
      steeringPolicy: args.routingPolicy === "latency" ? "dynamic_latency" : "geo",
      proxied: false,
    },
    opts,
  );

  return { pool, loadBalancer, recordSetId: loadBalancer.id };
}
