import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface RegistryAwsEcrArgs {
  region: string;
  repositoryName: string;
}

export interface RegistryAwsEcrOutputs {
  repository: aws.ecr.Repository;
  repositoryUrl: pulumi.Output<string>;
  /** `docker login`-ready auth: registry endpoint + short-lived username/password. */
  auth: {
    registryUrl: pulumi.Output<string>;
    username: pulumi.Output<string>;
    password: pulumi.Output<string>;
  };
}

/**
 * Module ID: `registry.aws.ecr`
 */
export function registryAwsEcr(
  name: string,
  args: RegistryAwsEcrArgs,
  opts?: pulumi.ComponentResourceOptions,
): RegistryAwsEcrOutputs {
  const provider = new aws.Provider(`${name}-aws`, { region: args.region }, opts);

  const repository = new aws.ecr.Repository(
    name,
    {
      name: args.repositoryName,
      imageTagMutability: "IMMUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
    },
    { ...opts, provider },
  );

  const token = aws.ecr.getAuthorizationTokenOutput({}, { provider });

  return {
    repository,
    repositoryUrl: repository.repositoryUrl,
    auth: {
      registryUrl: token.proxyEndpoint,
      username: token.userName,
      password: token.password,
    },
  };
}
