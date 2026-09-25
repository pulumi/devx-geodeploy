import type { CandidateCost } from "@geodeploy/core";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * A plain-text ranked table for the `price` CLI command: one row per
 * candidate, cheapest first (candidates are expected to already be sorted by
 * `rankCandidates`, but this does not re-sort — the caller's order is
 * preserved so a caller can pass a deliberately truncated/reordered list).
 */
export function renderPriceTable(candidates: readonly CandidateCost[]): string {
  const headers = ["PROVIDER", "REGION", "SKU", "ARCH", "NODES", "MONTHLY USD", "DISTANCE KM", "REALISM"];
  const rows = candidates.map((c) => [
    c.provider,
    c.region,
    c.sku,
    c.arch,
    String(c.nodesNeeded),
    c.monthlyUsd.toFixed(2),
    c.distanceKm.toFixed(0),
    c.realism,
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));

  const formatRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i]!)).join("  ");

  if (candidates.length === 0) {
    return "No priced candidates.\n";
  }

  const lines = [formatRow(headers), formatRow(widths.map((w) => "-".repeat(w))), ...rows.map((r) => formatRow(r))];
  return lines.join("\n") + "\n";
}
