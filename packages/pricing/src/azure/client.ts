import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Realism } from "@geodeploy/core";
import { FsCache } from "../cache.js";
import { defaultFetch, fetchJson, type FetchLike } from "../http.js";
import { retailPricesUrl } from "./constants.js";
import type { AzureRetailItem, AzureRetailPricesPage } from "./types.js";

export interface AzureRetailPriceResult {
  items: AzureRetailItem[];
  /** Exact URL(s) queried (live) or fixture file path (fixture), for audit. */
  source: string;
}

export interface AzureRetailPriceSource {
  readonly realism: Realism;
  fetchItems(filter: string): Promise<AzureRetailPriceResult>;
}

export interface LiveAzureRetailPriceSourceOptions {
  fetchImpl?: FetchLike;
  cache?: FsCache;
}

/** Real client: follows `NextPageLink` (1,000 records/page) until exhausted. */
export function createLiveAzureRetailPriceSource(opts: LiveAzureRetailPriceSourceOptions = {}): AzureRetailPriceSource {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const cache = opts.cache ?? new FsCache();

  return {
    realism: "live",
    async fetchItems(filter) {
      const firstUrl = retailPricesUrl(filter);
      const items: AzureRetailItem[] = [];
      let url: string | null = firstUrl;
      while (url) {
        const currentUrl: string = url;
        const page: AzureRetailPricesPage = await cache.getOrFetch(currentUrl, () =>
          fetchJson<AzureRetailPricesPage>(fetchImpl, currentUrl),
        );
        items.push(...page.Items);
        url = page.NextPageLink;
      }
      return { items, source: firstUrl };
    },
  };
}

/**
 * Fixture client: reads a small, trimmed, recorded page of retail-prices JSON
 * from disk. Since fixtures are hand-trimmed to a handful of items, a single
 * file per logical query is enough — no pagination to simulate.
 * Filenames follow the convention `<hash-of-filter>.json`, with a
 * human-readable manifest (`manifest.json`) mapping filter -> filename for
 * anyone inspecting the fixture directory.
 */
export function createFixtureAzureRetailPriceSource(fixtureDir: string): AzureRetailPriceSource {
  return {
    realism: "fixture",
    async fetchItems(filter) {
      const manifestPath = path.join(fixtureDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, string>;
      const filename = manifest[filter];
      if (!filename) {
        throw new Error(
          `Azure fixture manifest has no entry for filter: ${filter}\n(looked in ${manifestPath})`,
        );
      }
      const filePath = path.join(fixtureDir, filename);
      const page = JSON.parse(await readFile(filePath, "utf8")) as AzureRetailPricesPage;
      return { items: page.Items, source: filePath };
    },
  };
}

/** Stable, human-inspectable-adjacent key for a filter string (used by fixture recording tooling). */
export function filterCacheKey(filter: string): string {
  return createHash("sha256").update(filter).digest("hex").slice(0, 16);
}
