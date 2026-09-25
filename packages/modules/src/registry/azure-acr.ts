import * as pulumi from "@pulumi/pulumi";
import { resources, containerregistry } from "@pulumi/azure-native";

export interface RegistryAzureAcrArgs {
  location: string;
  registryName: string;
  resourceGroupName?: pulumi.Input<string>;
}

export interface RegistryAzureAcrOutputs {
  registry: containerregistry.Registry;
  loginServer: pulumi.Output<string>;
  auth: {
    username: pulumi.Output<string>;
    password: pulumi.Output<string>;
  };
}

/**
 * Module ID: `registry.azure.acr`
 */
export function registryAzureAcr(
  name: string,
  args: RegistryAzureAcrArgs,
  opts?: pulumi.ComponentResourceOptions,
): RegistryAzureAcrOutputs {
  const rg = args.resourceGroupName
    ? undefined
    : new resources.ResourceGroup(`${name}-rg`, { location: args.location }, opts);
  const resourceGroupName = args.resourceGroupName ?? rg!.name;

  const registry = new containerregistry.Registry(
    name,
    {
      resourceGroupName,
      location: args.location,
      registryName: args.registryName,
      adminUserEnabled: true,
      sku: { name: containerregistry.SkuName.Basic },
    },
    opts,
  );

  const creds = containerregistry.listRegistryCredentialsOutput({
    resourceGroupName,
    registryName: registry.name,
  });

  return {
    registry,
    loginServer: registry.loginServer,
    auth: {
      username: creds.apply((c) => c.username ?? ""),
      password: creds.apply((c) => c.passwords?.[0]?.value ?? ""),
    },
  };
}
