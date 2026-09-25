import * as pulumi from "@pulumi/pulumi";
import { resources, containerservice } from "@pulumi/azure-native";

export interface ClusterAzureAksArgs {
  location: string;
  dnsPrefix: string;
  nodeCount?: number;
  vmSize?: string;
  /** Existing resource group to deploy into; a dedicated one is created when omitted. */
  resourceGroupName?: pulumi.Input<string>;
}

export interface ClusterAzureAksOutputs {
  cluster: containerservice.ManagedCluster;
  resourceGroupName: pulumi.Output<string>;
  clusterName: pulumi.Output<string>;
  /** Kubeconfig as a JSON... actually plain YAML string decoded from the base64 admin/user credential. */
  kubeconfig: pulumi.Output<string>;
}

/**
 * Module ID: `cluster.azure.aks`
 *
 * Constructs an AKS `ManagedCluster` with at least one inline `agentPoolProfiles`
 * entry, and assembles its kubeconfig via `listManagedClusterUserCredentials`.
 */
export function clusterAzureAks(
  name: string,
  args: ClusterAzureAksArgs,
  opts?: pulumi.ComponentResourceOptions,
): ClusterAzureAksOutputs {
  const rg = args.resourceGroupName
    ? undefined
    : new resources.ResourceGroup(`${name}-rg`, { location: args.location }, opts);
  const resourceGroupName = args.resourceGroupName ?? rg!.name;

  const cluster = new containerservice.ManagedCluster(
    name,
    {
      resourceGroupName,
      location: args.location,
      dnsPrefix: args.dnsPrefix,
      identity: { type: containerservice.ResourceIdentityType.SystemAssigned },
      agentPoolProfiles: [
        {
          name: "system",
          count: args.nodeCount ?? 2,
          vmSize: args.vmSize ?? "Standard_DS2_v2",
          mode: "System",
          osType: "Linux",
        },
      ],
    },
    opts,
  );

  const creds = containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName,
    resourceName: cluster.name,
  });

  const kubeconfig = creds.kubeconfigs.apply((list) => {
    const first = list[0];
    if (!first?.value) {
      throw new Error("AKS did not return a kubeconfig credential");
    }
    return Buffer.from(first.value, "base64").toString("utf-8");
  });

  return {
    cluster,
    resourceGroupName: pulumi.output(resourceGroupName),
    clusterName: cluster.name,
    kubeconfig,
  };
}
