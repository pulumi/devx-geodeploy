// A closed, typed map from module ID string -> factory function. This is the
// only place module IDs are resolved to code: never `eval`, never a template
// string. Adding a provider means adding a reviewed entry here.

import { clusterAwsEks } from "./cluster/aws-eks.js";
import { clusterAzureAks } from "./cluster/azure-aks.js";
import { clusterGcpGke } from "./cluster/gcp-gke.js";
import { registryAwsEcr } from "./registry/aws-ecr.js";
import { registryAzureAcr } from "./registry/azure-acr.js";
import { registryGcpAr } from "./registry/gcp-ar.js";
import { imageBuildMultiarch } from "./image/multiarch.js";
import { workloadK8sManifest } from "./workload/manifest.js";
import { ingressK8sServiceLb } from "./ingress/service-lb.js";
import { dnsAwsRoute53 } from "./dns/aws-route53.js";
import { dnsNs1 } from "./dns/ns1.js";
import { dnsCloudflare } from "./dns/cloudflare.js";
import { obsK8sBaseline } from "./obs/baseline.js";

export const ClusterModules = {
  "cluster.aws.eks": clusterAwsEks,
  "cluster.azure.aks": clusterAzureAks,
  "cluster.gcp.gke": clusterGcpGke,
} as const;

export const RegistryModules = {
  "registry.aws.ecr": registryAwsEcr,
  "registry.azure.acr": registryAzureAcr,
  "registry.gcp.ar": registryGcpAr,
} as const;

export const DnsModules = {
  "dns.aws.route53": dnsAwsRoute53,
  "dns.ns1": dnsNs1,
  "dns.cloudflare": dnsCloudflare,
} as const;

export const MiscModules = {
  "image.build.multiarch": imageBuildMultiarch,
  "workload.k8s.manifest": workloadK8sManifest,
  "ingress.k8s.service-lb": ingressK8sServiceLb,
  "obs.k8s.baseline": obsK8sBaseline,
} as const;

/** The full closed set, keyed by module ID, as used by `packages/compose`. */
export const ModuleRegistry = {
  ...ClusterModules,
  ...RegistryModules,
  ...DnsModules,
  ...MiscModules,
} as const;

export type ClusterModuleId = keyof typeof ClusterModules;
export type RegistryModuleId = keyof typeof RegistryModules;
export type DnsModuleId = keyof typeof DnsModules;
export type ModuleId = keyof typeof ModuleRegistry;

export function isClusterModuleId(id: string): id is ClusterModuleId {
  return id in ClusterModules;
}

export function isRegistryModuleId(id: string): id is RegistryModuleId {
  return id in RegistryModules;
}

export function isDnsModuleId(id: string): id is DnsModuleId {
  return id in DnsModules;
}
