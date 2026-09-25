import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface ClusterGcpGkeArgs {
  location: string;
  /** GCP project; defaults to the ambient provider configuration when omitted. */
  project?: string;
  machineType?: string;
  initialNodeCount?: number;
  enableAutopilot?: boolean;
}

export interface ClusterGcpGkeOutputs {
  cluster: gcp.container.Cluster;
  clusterName: pulumi.Output<string>;
  /** Kubeconfig assembled from `endpoint` + `masterAuth`, as a JSON string. */
  kubeconfig: pulumi.Output<string>;
}

/**
 * Module ID: `cluster.gcp.gke`
 *
 * Constructs a GKE cluster (standard node pool, or Autopilot when
 * `enableAutopilot` is set) via `@pulumi/gcp`, and assembles a kubeconfig from
 * the cluster's `endpoint` + `masterAuth.clusterCaCertificate` (the pattern
 * GKE requires since it has no single "kubeconfig" output like EKS/AKS).
 */
export function clusterGcpGke(
  name: string,
  args: ClusterGcpGkeArgs,
  opts?: pulumi.ComponentResourceOptions,
): ClusterGcpGkeOutputs {
  const cluster = new gcp.container.Cluster(
    name,
    args.enableAutopilot
      ? {
          location: args.location,
          project: args.project,
          enableAutopilot: true,
          deletionProtection: false,
        }
      : {
          location: args.location,
          project: args.project,
          initialNodeCount: args.initialNodeCount ?? 2,
          nodeConfig: { machineType: args.machineType ?? "e2-medium" },
          deletionProtection: false,
        },
    opts,
  );

  const clientConfig = gcp.organizations.getClientConfigOutput();

  const kubeconfig = pulumi
    .all([cluster.name, cluster.endpoint, cluster.masterAuth, clientConfig.accessToken])
    .apply(([clusterName, endpoint, masterAuth, accessToken]) =>
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: clusterName,
            cluster: {
              server: `https://${endpoint}`,
              "certificate-authority-data": masterAuth.clusterCaCertificate,
            },
          },
        ],
        contexts: [{ name: clusterName, context: { cluster: clusterName, user: clusterName } }],
        "current-context": clusterName,
        users: [{ name: clusterName, user: { token: accessToken } }],
      }),
    );

  return {
    cluster,
    clusterName: cluster.name,
    kubeconfig,
  };
}
