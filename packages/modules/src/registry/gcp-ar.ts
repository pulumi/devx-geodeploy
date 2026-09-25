import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface RegistryGcpArArgs {
  location: string;
  repositoryId: string;
  project?: string;
}

export interface RegistryGcpArOutputs {
  repository: gcp.artifactregistry.Repository;
  /** `<location>-docker.pkg.dev/<project>/<repositoryId>` */
  registryUrl: pulumi.Output<string>;
  auth: {
    /** Artifact Registry docker auth always uses this literal username. */
    username: pulumi.Output<string>;
    /** Short-lived OAuth2 access token, used as the docker login password. */
    password: pulumi.Output<string>;
  };
}

/**
 * Module ID: `registry.gcp.ar`
 */
export function registryGcpAr(
  name: string,
  args: RegistryGcpArArgs,
  opts?: pulumi.ComponentResourceOptions,
): RegistryGcpArOutputs {
  const repository = new gcp.artifactregistry.Repository(
    name,
    {
      location: args.location,
      project: args.project,
      repositoryId: args.repositoryId,
      format: "DOCKER",
    },
    opts,
  );

  const clientConfig = gcp.organizations.getClientConfigOutput();

  const registryUrl = pulumi
    .all([repository.location, clientConfig.project, repository.repositoryId])
    .apply(([location, project, repositoryId]) => `${location}-docker.pkg.dev/${project}/${repositoryId}`);

  return {
    repository,
    registryUrl,
    auth: {
      username: pulumi.output("oauth2accesstoken"),
      password: clientConfig.accessToken,
    },
  };
}
