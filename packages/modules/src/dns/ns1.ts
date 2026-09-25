import * as pulumi from "@pulumi/pulumi";
import * as ns1 from "@pulumi/ns1";
import type { DnsModuleArgs, DnsModuleOutputs } from "./shared.js";

export interface DnsNs1Args extends DnsModuleArgs {
  zone: string;
  ttl?: number;
}

export type DnsNs1Outputs = DnsModuleOutputs & { record: ns1.Record };

/**
 * Module ID: `dns.ns1`
 *
 * A single NS1 `Record` carries every target as an answer bound to its own
 * named region (answer group). Geo policy tags each region's `meta.georegion`
 * from `routingKey`; latency policy attaches NS1's `latency` filter (which
 * ranks answers by measured round-trip time) ahead of a `shuffle` tiebreaker.
 */
export function dnsNs1(name: string, args: DnsNs1Args, opts?: pulumi.ComponentResourceOptions): DnsNs1Outputs {
  const regionNames = args.targetEndpoints.map((_, i) => `${name}-region-${String(i).padStart(3, "0")}`);

  const record = new ns1.Record(
    name,
    {
      zone: args.zone,
      domain: args.recordName,
      type: "CNAME",
      ttl: args.ttl ?? 60,
      answers: args.targetEndpoints.map((target, i) => ({
        answer: target.endpoint,
        region: regionNames[i],
      })),
      regions: args.targetEndpoints.map((target, i) => ({
        name: regionNames[i]!,
        meta: args.routingPolicy === "geo" ? { georegion: target.routingKey ?? "" } : {},
      })),
      filters:
        args.routingPolicy === "latency"
          ? [{ filter: "latency" }, { filter: "shuffle" }]
          : [{ filter: "geotarget_country" }, { filter: "select_first_n", config: { N: "1" } }],
    },
    opts,
  );

  return { record, recordSetId: record.id };
}
