import * as pulumi from "@pulumi/pulumi";
import * as dockerBuild from "@pulumi/docker-build";

export interface RegistryAuth {
  registryUrl: pulumi.Input<string>;
  username: pulumi.Input<string>;
  password: pulumi.Input<string>;
}

export interface ImageBuildMultiarchArgs {
  /** Build context directory (defaults to cwd). */
  contextPath?: pulumi.Input<string>;
  dockerfilePath?: pulumi.Input<string>;
  /** Registry the built image is pushed to and tagged against. */
  registry: RegistryAuth;
  /** Repository path within the registry, e.g. "myorg/myapp" or the full ECR/ACR/AR repo name. */
  repositoryName: pulumi.Input<string>;
  tag?: string;
  buildArgs?: Record<string, pulumi.Input<string>>;
}

export interface ImageBuildMultiarchOutputs {
  image: dockerBuild.Image;
  ref: pulumi.Output<string>;
  digest: pulumi.Output<string>;
}

/**
 * Module ID: `image.build.multiarch`
 *
 * Multi-platform (amd64 + arm64) buildx/BuildKit image build via
 * `@pulumi/docker-build`, pushed to the registry the caller resolved (ECR/ACR/AR),
 * with registry-backed inline cache import/export.
 */
export function imageBuildMultiarch(
  name: string,
  args: ImageBuildMultiarchArgs,
  opts?: pulumi.ComponentResourceOptions,
): ImageBuildMultiarchOutputs {
  const tag = args.tag ?? "latest";
  const ref = pulumi.interpolate`${args.registry.registryUrl}/${args.repositoryName}:${tag}`;

  const image = new dockerBuild.Image(
    name,
    {
      context: { location: args.contextPath ?? "." },
      dockerfile: args.dockerfilePath ? { location: args.dockerfilePath } : undefined,
      platforms: ["linux/amd64", "linux/arm64"],
      push: true,
      tags: [ref],
      buildArgs: args.buildArgs,
      registries: [
        {
          address: args.registry.registryUrl,
          username: args.registry.username,
          password: args.registry.password,
        },
      ],
      cacheFrom: [{ registry: { ref } }],
      cacheTo: [{ inline: {} }],
    },
    opts,
  );

  return {
    image,
    ref: image.ref,
    digest: image.digest,
  };
}
