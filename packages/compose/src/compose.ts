import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import type { RegionPlan, DnsPlan, Provider, DnsProvider } from "@geodeploy/core";
import {
  clusterAwsEks,
  clusterAzureAks,
  clusterGcpGke,
  registryAwsEcr,
  registryAzureAcr,
  registryGcpAr,
  workloadK8sManifest,
  ingressK8sServiceLb,
  dnsAwsRoute53,
  dnsNs1,
  dnsCloudflare,
  isClusterModuleId,
  isRegistryModuleId,
  isDnsModuleId,
  type ModuleId,
  type DnsRecordTarget,
} from "@geodeploy/modules";

// The module ID each provider mechanically implies (Stage B of the decision
// engine looks this up rather than asking anything — see PROJECT-PLAN §5.5/§5.6
// and the restored-scope plan's "Decision engine" section). The composer
// re-validates the plan actually agrees, so a bad plan fails loudly here
// rather than deep inside a mismatched Pulumi call.
const CLUSTER_MODULE_FOR_PROVIDER: Record<Provider, ModuleId> = {
  aws: "cluster.aws.eks",
  azure: "cluster.azure.aks",
  gcp: "cluster.gcp.gke",
};

const REGISTRY_MODULE_FOR_PROVIDER: Record<Provider, ModuleId> = {
  aws: "registry.aws.ecr",
  azure: "registry.azure.acr",
  gcp: "registry.gcp.ar",
};

// Real bug found via the first real (non-fixture) `geodeploy apply` run:
// the decision engine only ever produces one of three INGRESS POSTURE ids
// (packages/decide/src/questions.ts's INGRESS_OPTIONS / fallback.ts's
// REGISTRY_DEFAULT_INGRESS = "ingress.public-alb") — but packages/modules's
// registry only ever registered one concrete K8s-level IMPLEMENTATION,
// under the unrelated id "ingress.k8s.service-lb". Every plan's apply
// failed outright at this exact check, 100% of the time, until this fix —
// simply because a strict equality check was comparing a posture id against
// an implementation id from two different, never-reconciled namespaces.
//
// Until dedicated WAF-fronted/internal-only modules exist, all three
// postures map to the same real implementation (a plain LoadBalancer
// Service) — RegionPlan.modules.ingress still records which posture was
// actually decided (for audit/display), this map only governs which
// concrete Pulumi resources compose.ts builds.
const INGRESS_MODULE_FOR_POSTURE: Record<string, ModuleId> = {
  "ingress.public-alb": "ingress.k8s.service-lb",
  "ingress.waf-fronted": "ingress.k8s.service-lb",
  "ingress.internal-only": "ingress.k8s.service-lb",
};

const DNS_MODULE_FOR_PROVIDER: Record<DnsProvider, ModuleId> = {
  route53: "dns.aws.route53",
  ns1: "dns.ns1",
  cloudflare: "dns.cloudflare",
};

export interface ComposeIngressConfig {
  selector: Record<string, pulumi.Input<string>>;
  ports: Array<{ name?: string; port: number; targetPort: number | string; protocol?: "TCP" | "UDP" }>;
}

export interface ComposeDnsConfig {
  recordName: string;
  routingPolicy: "latency" | "geo";
  /** Provider-specific routing hint for this region's target (see `@geodeploy/modules` dns/shared.ts). */
  routingKey?: string;
  route53?: { zoneId: pulumi.Input<string> };
  ns1?: { zone: string };
  cloudflare?: { zoneId: pulumi.Input<string>; accountId: pulumi.Input<string> };
}

export interface ComposeConfig {
  /** Paths to the user's own Kubernetes manifests, applied via `workload.k8s.manifest`. */
  workloadManifestFiles: string[];
  ingress: ComposeIngressConfig;
  /**
   * Present only when this region's stack also owns the DNS record (a
   * simplification of §5.7's "global DNS stack consumes region outputs via
   * stack references" for single-program composition/testing purposes; real
   * multi-region DNS aggregation happens one level up, in `packages/provision`).
   */
  dns?: ComposeDnsConfig;
}

/**
 * Builds an inline Pulumi program (a `PulumiFn`, per the Automation API) for
 * one region: cluster -> kubeconfig -> `kubernetes.Provider` -> workload, all
 * in the same program, per the Pulumi providers doc's own recommended pattern.
 * DNS is wired in the same program when `dnsPlan.provider` is non-null, using
 * whichever DNS module that provider implies — entirely independent of
 * `regionPlan.provider` (a DNS backend is never dictated by which cloud runs
 * compute).
 */
export function composeProgram(
  regionPlan: RegionPlan,
  dnsPlan: DnsPlan,
  config: ComposeConfig,
): () => Promise<Record<string, unknown>> {
  return async () => {
    const expectedCluster = CLUSTER_MODULE_FOR_PROVIDER[regionPlan.provider];
    if (regionPlan.modules.cluster !== expectedCluster || !isClusterModuleId(regionPlan.modules.cluster)) {
      throw new Error(
        `RegionPlan.modules.cluster ("${regionPlan.modules.cluster}") does not match the module ` +
          `provider "${regionPlan.provider}" implies ("${expectedCluster}")`,
      );
    }
    const expectedRegistry = REGISTRY_MODULE_FOR_PROVIDER[regionPlan.provider];
    if (regionPlan.modules.registry !== expectedRegistry || !isRegistryModuleId(regionPlan.modules.registry)) {
      throw new Error(
        `RegionPlan.modules.registry ("${regionPlan.modules.registry}") does not match the module ` +
          `provider "${regionPlan.provider}" implies ("${expectedRegistry}")`,
      );
    }
    if (!(regionPlan.modules.ingress in INGRESS_MODULE_FOR_POSTURE)) {
      throw new Error(
        `RegionPlan.modules.ingress ("${regionPlan.modules.ingress}") is not a recognized ingress posture`,
      );
    }

    const baseName = `${regionPlan.geoId}-${regionPlan.provider}`;

    let kubeconfig: pulumi.Output<string>;
    let clusterName: pulumi.Output<string>;
    let registryUrl: pulumi.Output<string>;

    switch (regionPlan.provider) {
      case "aws": {
        const cluster = clusterAwsEks(`${baseName}-cluster`, {
          region: regionPlan.region,
          instanceType: regionPlan.sku,
          desiredCapacity: regionPlan.nodesNeeded,
          minSize: Math.max(1, Math.floor(regionPlan.nodesNeeded * 0.5)),
          maxSize: Math.max(regionPlan.nodesNeeded, Math.ceil(regionPlan.nodesNeeded * 1.5)),
        });
        kubeconfig = cluster.kubeconfig;
        clusterName = cluster.clusterName;
        const registry = registryAwsEcr(`${baseName}-registry`, {
          region: regionPlan.region,
          repositoryName: regionPlan.geoId,
        });
        registryUrl = registry.repositoryUrl;
        break;
      }
      case "azure": {
        const cluster = clusterAzureAks(`${baseName}-cluster`, {
          location: regionPlan.region,
          dnsPrefix: sanitizeName(`${regionPlan.geoId}-${regionPlan.region}`, 54),
          vmSize: regionPlan.sku,
          nodeCount: regionPlan.nodesNeeded,
        });
        kubeconfig = cluster.kubeconfig;
        clusterName = cluster.clusterName;
        const registry = registryAzureAcr(`${baseName}-registry`, {
          location: regionPlan.region,
          registryName: sanitizeName(`${regionPlan.geoId}${regionPlan.region}`, 50, /* alnumOnly */ true),
        });
        registryUrl = registry.loginServer;
        break;
      }
      case "gcp": {
        const cluster = clusterGcpGke(`${baseName}-cluster`, {
          location: regionPlan.region,
          machineType: regionPlan.sku,
          initialNodeCount: regionPlan.nodesNeeded,
        });
        kubeconfig = cluster.kubeconfig;
        clusterName = cluster.clusterName;
        const registry = registryGcpAr(`${baseName}-registry`, {
          location: regionPlan.region,
          repositoryId: sanitizeName(regionPlan.geoId, 63),
        });
        registryUrl = registry.registryUrl;
        break;
      }
    }

    // The pattern from Pulumi's own providers doc: feed the cluster's
    // kubeconfig into a `kubernetes.Provider`, then deploy into it in the
    // same program.
    const k8sProvider = new kubernetes.Provider(`${baseName}-k8s`, { kubeconfig });

    const workload = workloadK8sManifest(
      `${baseName}-workload`,
      { files: config.workloadManifestFiles },
      { provider: k8sProvider },
    );

    const ingress = ingressK8sServiceLb(`${baseName}-ingress`, config.ingress, { provider: k8sProvider });

    const outputs: Record<string, unknown> = {
      clusterName,
      registryUrl,
      externalEndpoint: ingress.externalEndpoint,
      workloadResourceName: workload.configGroup.urn,
      // Marked secret so it's encrypted in Pulumi state; `packages/observe`
      // reads it back via `stack.outputs()` (never `preview()`/`up()`) so a
      // live-metrics poll never needs its own copy of cluster credentials on
      // disk anywhere.
      kubeconfig: pulumi.secret(kubeconfig),
    };

    if (dnsPlan.provider !== null) {
      if (!config.dns) {
        throw new Error(`dnsPlan selected provider "${dnsPlan.provider}" but no ComposeConfig.dns was supplied`);
      }
      const expectedDns = DNS_MODULE_FOR_PROVIDER[dnsPlan.provider];
      if (!isDnsModuleId(expectedDns)) {
        throw new Error(`Unknown DNS module for provider "${dnsPlan.provider}"`);
      }

      const target: DnsRecordTarget = {
        endpoint: ingress.externalEndpoint,
        ...(config.dns.routingKey !== undefined ? { routingKey: config.dns.routingKey } : {}),
      };

      switch (dnsPlan.provider) {
        case "route53": {
          if (!config.dns.route53) throw new Error("ComposeConfig.dns.route53 required for provider route53");
          const dns = dnsAwsRoute53(`${baseName}-dns`, {
            recordName: config.dns.recordName,
            targetEndpoints: [target],
            routingPolicy: config.dns.routingPolicy,
            zoneId: config.dns.route53.zoneId,
          });
          outputs.dnsRecordSetId = dns.recordSetId;
          break;
        }
        case "ns1": {
          if (!config.dns.ns1) throw new Error("ComposeConfig.dns.ns1 required for provider ns1");
          const dns = dnsNs1(`${baseName}-dns`, {
            recordName: config.dns.recordName,
            targetEndpoints: [target],
            routingPolicy: config.dns.routingPolicy,
            zone: config.dns.ns1.zone,
          });
          outputs.dnsRecordSetId = dns.recordSetId;
          break;
        }
        case "cloudflare": {
          if (!config.dns.cloudflare) throw new Error("ComposeConfig.dns.cloudflare required for provider cloudflare");
          const dns = dnsCloudflare(`${baseName}-dns`, {
            recordName: config.dns.recordName,
            targetEndpoints: [target],
            routingPolicy: config.dns.routingPolicy,
            zoneId: config.dns.cloudflare.zoneId,
            accountId: config.dns.cloudflare.accountId,
          });
          outputs.dnsRecordSetId = dns.recordSetId;
          break;
        }
      }
    }

    return outputs;
  };
}

/** Cloud registry/DNS-prefix name fields are far stricter than our geoId/region strings. */
function sanitizeName(input: string, maxLen: number, alnumOnly = false): string {
  const pattern = alnumOnly ? /[^a-zA-Z0-9]/g : /[^a-zA-Z0-9-]/g;
  return input.replace(pattern, "").toLowerCase().slice(0, maxLen);
}
