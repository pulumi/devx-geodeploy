import { PriceQuoteSchema, type Arch, type PriceQuote, type Provider, type Realism } from "@geodeploy/core";

// Every provider adapter reduces its raw upstream response down to this shape,
// then hands it to `toPriceQuote` which stamps currency/asOf and validates the
// result against the shared zod schema before it ever reaches `packages/cost`.
export interface RawPriceFacts {
  provider: Provider;
  region: string;
  sku: string;
  vcpu: number;
  memGiB: number;
  arch: Arch;
  nodeUsdPerHour: number;
  controlPlaneUsdPerHour: number;
  egressUsdPerGiB: number;
  blockStorageUsdPerGiBMonth: number;
  loadBalancerUsdPerHour: number;
  /** "live" when every figure above came from a real API response this run. */
  realism: Realism;
  /** Exact URL(s)/query used (live) or fixture file path(s) (fixture), for audit. */
  source: string;
  /** ISO timestamp the figures are as-of. Defaults to now. */
  asOf?: string;
}

export function toPriceQuote(facts: RawPriceFacts): PriceQuote {
  const quote: PriceQuote = {
    provider: facts.provider,
    region: facts.region,
    sku: facts.sku,
    vcpu: facts.vcpu,
    memGiB: facts.memGiB,
    arch: facts.arch,
    nodeUsdPerHour: facts.nodeUsdPerHour,
    controlPlaneUsdPerHour: facts.controlPlaneUsdPerHour,
    egressUsdPerGiB: facts.egressUsdPerGiB,
    blockStorageUsdPerGiBMonth: facts.blockStorageUsdPerGiBMonth,
    loadBalancerUsdPerHour: facts.loadBalancerUsdPerHour,
    currency: "USD",
    asOf: facts.asOf ?? new Date().toISOString(),
    realism: facts.realism,
    source: facts.source,
  };
  // Parse (not just typecheck) so a provider adapter bug — e.g. a negative
  // price from a mis-parsed tier — fails loudly here instead of silently
  // propagating into cost math.
  return PriceQuoteSchema.parse(quote);
}
