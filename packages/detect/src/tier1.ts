// Tier-1 presence checks: env vars + known config-file existence only.
// No network, no SDKs, instant — safe to call on every `plan`. Every function
// here is pure with respect to its inputs (process.env / fs.existsSync), which
// keeps it trivially mockable in tests via vi.stubEnv / vi.spyOn(fs, "existsSync").

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DnsProvider, Provider } from "@geodeploy/core";

export interface Tier1Result {
  tier1: boolean;
  detail: string;
}

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export function checkAwsTier1(): Tier1Result {
  const hasKeyPair = Boolean(process.env.AWS_ACCESS_KEY_ID) && Boolean(process.env.AWS_SECRET_ACCESS_KEY);
  if (hasKeyPair) {
    return { tier1: true, detail: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are both set." };
  }

  const profile = process.env.AWS_PROFILE;
  if (profile) {
    const credentialsPath = homePath(".aws", "credentials");
    const configPath = homePath(".aws", "config");
    if (fs.existsSync(credentialsPath) || fs.existsSync(configPath)) {
      return {
        tier1: true,
        detail: `AWS_PROFILE=${profile} is set and ~/.aws/credentials or ~/.aws/config exists.`,
      };
    }
  }

  if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    return {
      tier1: true,
      detail: "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set (container/task-role credentials).",
    };
  }

  return {
    tier1: false,
    detail:
      "checked AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE + ~/.aws/credentials or ~/.aws/config, " +
      "and AWS_CONTAINER_CREDENTIALS_RELATIVE_URI — none present.",
  };
}

export function checkAzureTier1(): Tier1Result {
  const hasServicePrincipal =
    Boolean(process.env.AZURE_CLIENT_ID) &&
    Boolean(process.env.AZURE_CLIENT_SECRET) &&
    Boolean(process.env.AZURE_TENANT_ID);
  if (hasServicePrincipal) {
    return {
      tier1: true,
      detail: "AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, and AZURE_TENANT_ID are all set.",
    };
  }

  const profilePath = homePath(".azure", "azureProfile.json");
  if (fs.existsSync(profilePath)) {
    return { tier1: true, detail: "~/.azure/azureProfile.json (Azure CLI login) was found." };
  }

  return {
    tier1: false,
    detail:
      "checked AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID and ~/.azure/azureProfile.json — none present.",
  };
}

export function checkGcpTier1(): Tier1Result {
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath && fs.existsSync(credsPath)) {
    return {
      tier1: true,
      detail: `GOOGLE_APPLICATION_CREDENTIALS points to an existing file at ${credsPath}.`,
    };
  }

  if (process.env.GOOGLE_API_KEY) {
    return { tier1: true, detail: "GOOGLE_API_KEY is set." };
  }

  const adcPath = homePath(".config", "gcloud", "application_default_credentials.json");
  if (fs.existsSync(adcPath)) {
    return {
      tier1: true,
      detail: "~/.config/gcloud/application_default_credentials.json (gcloud ADC) was found.",
    };
  }

  return {
    tier1: false,
    detail:
      "checked GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_API_KEY, and " +
      "~/.config/gcloud/application_default_credentials.json — none present.",
  };
}

export function checkNs1Tier1(): Tier1Result {
  if (process.env.NS1_APIKEY) {
    return { tier1: true, detail: "NS1_APIKEY is set." };
  }
  return { tier1: false, detail: "checked NS1_APIKEY — not present." };
}

export function checkCloudflareTier1(): Tier1Result {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { tier1: true, detail: "CLOUDFLARE_API_TOKEN is set." };
  }
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_EMAIL) {
    return { tier1: true, detail: "Legacy CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL are both set." };
  }
  return {
    tier1: false,
    detail: "checked CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL — none present.",
  };
}

export const providerTier1Checks: Record<Provider, () => Tier1Result> = {
  aws: checkAwsTier1,
  azure: checkAzureTier1,
  gcp: checkGcpTier1,
};

// Route53 authenticates with plain AWS credentials, so it reuses the AWS check.
export const dnsProviderTier1Checks: Record<DnsProvider, () => Tier1Result> = {
  route53: checkAwsTier1,
  ns1: checkNs1Tier1,
  cloudflare: checkCloudflareTier1,
};
