import * as pulumi from "@pulumi/pulumi";

/**
 * Generic offline `pulumi.runtime.setMocks` handler shared by every module
 * test. `newResource` fabricates a plausible id/state per resource type
 * token (falling back to echoing inputs plus a synthetic id) and `call`
 * fabricates plausible invoke ("data source") results for the specific
 * tokens our modules actually use. Zero network calls, zero cloud credentials.
 *
 * One real gotcha this uncovered: `@pulumi/eks`'s `Cluster` is a *remote*
 * multi-language component (a single `eks:index:Cluster` resource whose
 * actual child-resource construction happens inside a separate provider
 * plugin process, invisible to `setMocks`) rather than a plain in-process
 * `ComponentResource` tree. So its mock must return every declared output
 * field (`kubeconfigJson`, `eksCluster`, `core`, ...) directly in `state`,
 * unlike every other (plain, bridged-provider) resource here.
 */
export function installPulumiMocks(): void {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
        const id = `${args.name}-id`;
        const base: Record<string, unknown> = { ...args.inputs };

        switch (args.type) {
          // `@pulumi/eks` remote component: see doc comment above.
          case "eks:index:Cluster":
            return {
              id,
              state: {
                ...base,
                eksCluster: {
                  name: args.name,
                  arn: `arn:aws:eks:us-east-1:123456789012:cluster/${args.name}`,
                },
                core: { cluster: { name: args.name } },
                kubeconfig: { fake: true },
                kubeconfigJson: JSON.stringify({
                  apiVersion: "v1",
                  kind: "Config",
                  clusters: [{ name: args.name, cluster: { server: `https://${args.name}.eks.amazonaws.com` } }],
                }),
              },
            };

          case "gcp:container/cluster:Cluster":
            return {
              id,
              state: {
                ...base,
                name: base.name ?? args.name,
                endpoint: "34.1.2.3",
                masterAuth: { clusterCaCertificate: Buffer.from("fake-ca").toString("base64") },
                location: base.location ?? "us-central1",
              },
            };

          case "azure-native:containerservice:ManagedCluster":
            return {
              id,
              state: {
                ...base,
                name: args.name,
                fqdn: `${args.name}.hcp.eastus.azmk8s.io`,
              },
            };

          case "azure-native:resources:ResourceGroup":
            return { id, state: { ...base, name: args.name } };

          case "azure-native:containerregistry:Registry":
            return { id, state: { ...base, name: args.name, loginServer: `${args.name}.azurecr.io` } };

          case "aws:ecr/repository:Repository":
            return {
              id,
              state: {
                ...base,
                name: base.name ?? args.name,
                arn: `arn:aws:ecr:us-east-1:123456789012:repository/${args.name}`,
                repositoryUrl: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${args.name}`,
              },
            };

          case "gcp:artifactregistry/repository:Repository":
            return {
              id,
              state: {
                ...base,
                name: `projects/fake-project/locations/${base.location ?? "us-central1"}/repositories/${args.name}`,
                location: base.location ?? "us-central1",
                project: base.project ?? "fake-project",
              },
            };

          case "docker-build:index:Image":
            return {
              id,
              state: {
                ...base,
                ref: Array.isArray(base.tags) ? base.tags[0] : `example.com/${args.name}:latest`,
                digest: "sha256:" + "0".repeat(64),
              },
            };

          case "kubernetes:core/v1:Service":
            return {
              id,
              state: {
                ...base,
                status: {
                  loadBalancer: { ingress: [{ hostname: "", ip: "203.0.113.10" }] },
                  conditions: [],
                },
              },
            };

          default:
            return { id, state: base };
        }
      },
      call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
        switch (args.token) {
          case "aws:ecr/getAuthorizationToken:getAuthorizationToken":
            return {
              authorizationToken: Buffer.from("AWS:fake-password").toString("base64"),
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              id: "fake-token-id",
              password: "fake-password",
              proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
              region: "us-east-1",
              registryId: "123456789012",
              userName: "AWS",
            };
          case "gcp:organizations/getClientConfig:getClientConfig":
            return {
              accessToken: "fake-gcp-access-token",
              defaultLabels: {},
              id: "fake-client-config",
              project: "fake-project",
              region: "us-central1",
              zone: "us-central1-a",
            };
          case "azure-native:containerservice:listManagedClusterUserCredentials":
            return {
              kubeconfigs: [
                {
                  name: "clusterUser",
                  value: Buffer.from(
                    "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n",
                  ).toString("base64"),
                },
              ],
            };
          case "azure-native:containerregistry:listRegistryCredentials":
            return {
              username: "fake-acr-user",
              passwords: [{ name: "password", value: "fake-acr-password" }],
            };
          case "aws:ec2/getVpc:getVpc":
            return { ...args.inputs, id: "vpc-fake123", cidrBlock: "172.31.0.0/16" };
          case "aws:index/getAvailabilityZones:getAvailabilityZones":
            return {
              ...args.inputs,
              names: ["us-east-1a", "us-east-1b", "us-east-1e"],
              zoneIds: ["use1-az1", "use1-az2", "use1-az3"],
            };
          case "aws:ec2/getSubnets:getSubnets":
            return { ...args.inputs, ids: ["subnet-fake1", "subnet-fake2"] };
          default:
            return args.inputs;
        }
      },
    },
    "geodeploy-test",
    "test-stack",
    false /* dryrun (preview) */,
  );
}
