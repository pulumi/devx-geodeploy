// Tier-2 real identity checks: an actual network round-trip proving the
// tier-1-detected credentials are live and accepted. Only ever invoked (by
// index.ts) for a provider that already passed tier 1. Every check is wrapped
// so that a network error, a 401, or a timeout always resolves to `false` —
// never an uncaught rejection.

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DefaultAzureCredential } from "@azure/identity";
import { GoogleAuth } from "google-auth-library";
import type { DnsProvider, Provider } from "@geodeploy/core";

const TIER2_TIMEOUT_MS = 2000;

/** Races a promise against a timeout for SDKs that don't accept an AbortSignal. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tier2 check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function verifyAwsIdentity(): Promise<boolean> {
  const client = new STSClient({});
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER2_TIMEOUT_MS);
    try {
      await client.send(new GetCallerIdentityCommand({}), { abortSignal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

export async function verifyAzureIdentity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER2_TIMEOUT_MS);
    try {
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken("https://management.azure.com/.default", {
        abortSignal: controller.signal,
      });
      return token !== null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function verifyGcpIdentity(): Promise<boolean> {
  try {
    const auth = new GoogleAuth();
    const client = await withTimeout(auth.getClient(), TIER2_TIMEOUT_MS);
    const accessToken = await withTimeout(client.getAccessToken(), TIER2_TIMEOUT_MS);
    return Boolean(accessToken?.token);
  } catch {
    return false;
  }
}

export async function verifyNs1Identity(): Promise<boolean> {
  const apiKey = process.env.NS1_APIKEY;
  if (!apiKey) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER2_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.nsone.net/v1/account/", {
        headers: { "X-NSONE-Key": apiKey },
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function verifyCloudflareIdentity(): Promise<boolean> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const legacyKey = process.env.CLOUDFLARE_API_KEY;
  const legacyEmail = process.env.CLOUDFLARE_EMAIL;

  if (!token && !(legacyKey && legacyEmail)) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER2_TIMEOUT_MS);
    try {
      // tokens/verify only understands bearer-token auth; legacy key+email auth
      // is validated against the plain account-info endpoint instead.
      const url = token
        ? "https://api.cloudflare.com/client/v4/user/tokens/verify"
        : "https://api.cloudflare.com/client/v4/user";
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : { "X-Auth-Key": legacyKey as string, "X-Auth-Email": legacyEmail as string };

      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { success?: boolean };
      return body.success === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export const providerTier2Checks: Record<Provider, () => Promise<boolean>> = {
  aws: verifyAwsIdentity,
  azure: verifyAzureIdentity,
  gcp: verifyGcpIdentity,
};

// Route53 identity is just an AWS identity check.
export const dnsProviderTier2Checks: Record<DnsProvider, () => Promise<boolean>> = {
  route53: verifyAwsIdentity,
  ns1: verifyNs1Identity,
  cloudflare: verifyCloudflareIdentity,
};
