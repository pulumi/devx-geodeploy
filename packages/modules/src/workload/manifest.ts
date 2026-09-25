import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

export interface WorkloadK8sManifestArgs {
  /** Paths (or glob patterns) to raw Kubernetes manifest YAML files. */
  files: pulumi.Input<pulumi.Input<string>[]>;
  resourcePrefix?: string;
}

export interface WorkloadK8sManifestOutputs {
  configGroup: kubernetes.yaml.v2.ConfigGroup;
}

/**
 * Module ID: `workload.k8s.manifest`
 *
 * Applies the user's own Kubernetes manifests via `yaml.v2.ConfigGroup`. The
 * composer is responsible for passing `opts.provider` bound to the cluster's
 * kubeconfig so this lands in the cluster created earlier in the same program.
 */
export function workloadK8sManifest(
  name: string,
  args: WorkloadK8sManifestArgs,
  opts?: pulumi.ComponentResourceOptions,
): WorkloadK8sManifestOutputs {
  const configGroup = new kubernetes.yaml.v2.ConfigGroup(
    name,
    {
      files: args.files,
      resourcePrefix: args.resourcePrefix,
    },
    opts,
  );

  return { configGroup };
}
