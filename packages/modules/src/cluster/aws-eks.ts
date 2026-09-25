import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";

export interface ClusterAwsEksArgs {
  /** AWS region the cluster's control plane and node group live in. */
  region: string;
  instanceType?: string;
  desiredCapacity?: number;
  minSize?: number;
  maxSize?: number;
  vpcId?: pulumi.Input<string>;
  subnetIds?: pulumi.Input<pulumi.Input<string>[]>;
}

export interface ClusterAwsEksOutputs {
  cluster: eks.Cluster;
  /** Region-scoped explicit AWS provider the cluster (and any sibling resources) were created with. */
  provider: aws.Provider;
  /** Kubeconfig as a JSON string, ready to feed a `kubernetes.Provider`. */
  kubeconfig: pulumi.Output<string>;
  clusterName: pulumi.Output<string>;
}

// EKS refuses to place a control-plane ENI in a handful of legacy,
// pre-2013 availability zones that still show up in older AWS accounts'
// default VPCs -- us-east-1e is the one everyone eventually hits (a
// well-documented AWS/EKS gotcha; @pulumi/eks and eksctl users hit
// `UnsupportedAvailabilityZoneException` the same way). When we're
// discovering the default VPC/subnets ourselves (no explicit vpcId/subnetIds
// given), exclude it rather than let cluster creation fail depending on
// which AZs a given account's default VPC happens to span.
const EKS_UNSUPPORTED_AZS = new Set(["us-east-1e"]);

/**
 * Module ID: `cluster.aws.eks`
 *
 * Constructs a managed EKS cluster + node group via `@pulumi/eks`, bound to an
 * explicit, region-scoped `aws.Provider` (the "explicit providers" pattern from
 * the Pulumi docs), and exposes its kubeconfig for downstream `kubernetes.Provider`
 * construction in the same program.
 */
export function clusterAwsEks(
  name: string,
  args: ClusterAwsEksArgs,
  opts?: pulumi.ComponentResourceOptions,
): ClusterAwsEksOutputs {
  const provider = new aws.Provider(`${name}-aws`, { region: args.region }, opts);

  let vpcId = args.vpcId;
  let subnetIds = args.subnetIds;

  if (vpcId === undefined && subnetIds === undefined) {
    const defaultVpc = aws.ec2.getVpcOutput({ default: true }, { provider });
    const supportedAzs = aws
      .getAvailabilityZonesOutput({ state: "available" }, { provider })
      .names.apply((names) => names.filter((az) => !EKS_UNSUPPORTED_AZS.has(az)));
    const subnets = aws.ec2.getSubnetsOutput(
      {
        filters: [
          { name: "vpc-id", values: [defaultVpc.id] },
          { name: "availability-zone", values: supportedAzs },
        ],
      },
      { provider },
    );
    vpcId = defaultVpc.id;
    subnetIds = subnets.ids;
  }

  const cluster = new eks.Cluster(
    name,
    {
      instanceType: args.instanceType ?? "t3.medium",
      desiredCapacity: args.desiredCapacity ?? 2,
      minSize: args.minSize ?? 1,
      maxSize: args.maxSize ?? 3,
      ...(vpcId !== undefined ? { vpcId } : {}),
      ...(subnetIds !== undefined ? { subnetIds } : {}),
    },
    { ...opts, providers: { ...opts?.providers, aws: provider } },
  );

  return {
    cluster,
    provider,
    kubeconfig: cluster.kubeconfigJson,
    clusterName: cluster.eksCluster.name,
  };
}
