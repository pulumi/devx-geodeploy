import type { DeploymentPlan, Provider } from "@geodeploy/core";
import { verifyDnsReadiness, verifyProviderReadiness } from "@geodeploy/detect";

export interface ApplyReadinessResult {
  ready: boolean;
  /** One specific, human-readable blocker per failing provider/DNS backend. */
  blockers: string[];
}

/**
 * Apply-time readiness gate: real (tier1+tier2) checks, scoped to exactly the
 * providers/DNS backend this plan actually needs — never the full provider
 * list. `detect` already owns all credential-checking logic; this only
 * decides which providers to ask about and turns a failing result into a
 * specific blocker message.
 */
export async function checkApplyReadiness(plan: DeploymentPlan): Promise<ApplyReadinessResult> {
  const providers = [...new Set(plan.regions.map((r) => r.provider))] as Provider[];
  const blockers: string[] = [];

  const providerReadiness = await verifyProviderReadiness(providers);
  for (const r of providerReadiness) {
    if (!(r.tier1 && r.tier2 === true)) {
      blockers.push(`${r.provider}: ${r.detail}`);
    }
  }

  // A plan that picked no DNS backend already recorded why in dns.reason —
  // that's not an apply-time blocker in itself, and no DNS readiness check
  // is needed at all in that case.
  if (plan.dns.provider !== null) {
    const dnsReadiness = await verifyDnsReadiness([plan.dns.provider]);
    for (const r of dnsReadiness) {
      if (!(r.tier1 && r.tier2 === true)) {
        blockers.push(`dns/${r.provider}: ${r.detail}`);
      }
    }
  }

  return { ready: blockers.length === 0, blockers };
}
