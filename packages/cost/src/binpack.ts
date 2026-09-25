import type { Arch, CostBreakdown, PriceQuote, WorkloadSpec } from "@geodeploy/core";
import { computeMonthlyCost, NODE_HEADROOM_FACTOR, nodesNeeded } from "./tco.js";

export interface BinPackResult {
  /** The chosen SKU's price quote (carries provider, region, sku, arch, ...). */
  quote: PriceQuote;
  nodesNeeded: number;
  monthlyUsd: number;
  breakdown: CostBreakdown;
}

/**
 * Picks the cheapest SKU, from a set of PriceQuotes for a single
 * provider/region, that satisfies the workload's pod request.
 *
 * `quotes` is expected to hold every SKU available in that one provider/
 * region (mixing x86_64 and arm64 rows freely). When `allowedArches` is
 * given (derived from the container image's actual built platforms — see
 * `platformsToArches` in arch.ts), only quotes whose `arch` is in that set
 * are considered: a node whose architecture the image was never built for
 * cannot run it at all, so this is a hard compatibility filter, not a price
 * tie-breaker. When `allowedArches` is omitted, architecture is not
 * filtered (both are considered, price alone decides) — this is the right
 * default for cost-exploration callers (like the ad-hoc `price` command)
 * that have no specific image to check compatibility against, but a real
 * `DeploymentRequest` with a concrete `image.platforms` should always pass
 * it, since picking an incompatible architecture is a correctness bug, not
 * a preference. For each surviving SKU we compute how many nodes of that
 * shape the workload needs (bin-packing on both vCPU and memory, see
 * tco.ts) and the resulting full monthly bill, then return the cheapest by
 * `monthlyUsd`. SKUs that cannot host even a single pod (e.g.
 * requestsPerPod bigger than the node) are skipped, not treated as
 * free/zero-node.
 *
 * Returns `undefined` if no SKU in `quotes` can host the workload at all.
 */
export function pickCheapestSku(
  workload: WorkloadSpec,
  quotes: readonly PriceQuote[],
  headroomFactor: number = NODE_HEADROOM_FACTOR,
  allowedArches?: readonly Arch[],
): BinPackResult | undefined {
  let best: BinPackResult | undefined;

  for (const quote of quotes) {
    if (allowedArches && !allowedArches.includes(quote.arch)) continue;
    const n = nodesNeeded(workload.replicasPerRegion, quote, workload.requestsPerPod, headroomFactor);
    if (!Number.isFinite(n)) continue;

    const { breakdown, monthlyUsd } = computeMonthlyCost({
      nodesNeeded: n,
      nodeUsdPerHour: quote.nodeUsdPerHour,
      controlPlaneUsdPerHour: quote.controlPlaneUsdPerHour,
      egressGiBPerMonth: workload.egressGiBPerMonth,
      egressUsdPerGiB: quote.egressUsdPerGiB,
      storageGiB: workload.storageGiB,
      blockStorageUsdPerGiBMonth: quote.blockStorageUsdPerGiBMonth,
      loadBalancerUsdPerHour: quote.loadBalancerUsdPerHour,
    });

    if (!best || monthlyUsd < best.monthlyUsd) {
      best = { quote, nodesNeeded: n, monthlyUsd, breakdown };
    }
  }

  return best;
}
