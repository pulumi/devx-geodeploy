import { ALL_DNS_PROVIDERS, ALL_PROVIDERS } from "@geodeploy/core";
import type { DnsProvider, DnsReadiness, Provider, ProviderReadiness } from "@geodeploy/core";
import { dnsProviderTier1Checks, providerTier1Checks } from "./tier1.js";
import { dnsProviderTier2Checks, providerTier2Checks } from "./tier2.js";

// Tier-2 checks are real network calls; cache each provider's result for the
// lifetime of the process so repeated `verify*Readiness` calls within one
// `apply` don't re-hit the network.
const tier2Cache = new Map<string, Promise<boolean>>();

function cachedTier2(cacheKey: string, check: () => Promise<boolean>): Promise<boolean> {
  let cached = tier2Cache.get(cacheKey);
  if (!cached) {
    cached = check();
    tier2Cache.set(cacheKey, cached);
  }
  return cached;
}

/** Clears the tier-2 result cache. Exposed for tests only. */
export function resetTier2Cache(): void {
  tier2Cache.clear();
}

function tier2Detail(baseDetail: string, tier2: boolean): string {
  return tier2
    ? `${baseDetail} Tier-2 identity check succeeded.`
    : `${baseDetail} Tier-2 identity check failed (network error, invalid/expired credentials, or timeout).`;
}

/**
 * Tier-1 only: fast, offline, safe to call on every `plan`. Reports every
 * compute provider GeoDeploy knows about, not just ones already assumed usable.
 */
export async function detectProviderReadiness(): Promise<ProviderReadiness[]> {
  return ALL_PROVIDERS.map((provider) => {
    const { tier1, detail } = providerTier1Checks[provider]();
    return { provider, tier1, tier2: null, detail };
  });
}

/**
 * Tier-1 + tier-2 for the given providers: meant to be called during `apply`,
 * and only for the providers a plan actually needs. Tier 2 is only attempted
 * for a provider that already passed tier 1 — a provider with no credentials
 * at all stays `tier2: null` (not checked, not just false).
 */
export async function verifyProviderReadiness(providers: Provider[]): Promise<ProviderReadiness[]> {
  return Promise.all(
    providers.map(async (provider): Promise<ProviderReadiness> => {
      const { tier1, detail } = providerTier1Checks[provider]();
      if (!tier1) {
        return { provider, tier1, tier2: null, detail };
      }
      const tier2 = await cachedTier2(`provider:${provider}`, providerTier2Checks[provider]);
      return { provider, tier1, tier2, detail: tier2Detail(detail, tier2) };
    }),
  );
}

/** Tier-1 only for every DNS backend. Same contract as detectProviderReadiness. */
export async function detectDnsReadiness(): Promise<DnsReadiness[]> {
  return ALL_DNS_PROVIDERS.map((provider) => {
    const { tier1, detail } = dnsProviderTier1Checks[provider]();
    return { provider, tier1, tier2: null, detail };
  });
}

/** Tier-1 + tier-2 for the given DNS backends. Same contract as verifyProviderReadiness. */
export async function verifyDnsReadiness(providers: DnsProvider[]): Promise<DnsReadiness[]> {
  return Promise.all(
    providers.map(async (provider): Promise<DnsReadiness> => {
      const { tier1, detail } = dnsProviderTier1Checks[provider]();
      if (!tier1) {
        return { provider, tier1, tier2: null, detail };
      }
      const tier2 = await cachedTier2(`dns:${provider}`, dnsProviderTier2Checks[provider]);
      return { provider, tier1, tier2, detail: tier2Detail(detail, tier2) };
    }),
  );
}

export * from "./tier1.js";
export * from "./tier2.js";
