import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Realism } from "@geodeploy/core";
import { FsCache } from "../cache.js";
import { defaultFetch, type FetchLike } from "../http.js";
import { skusUrl } from "./constants.js";
import type { GcpSku, GcpSkusListResponse } from "./types.js";

export interface GcpSkusResult {
  skus: GcpSku[];
  /** Exact URL(s) queried (live) or fixture file path (fixture), for audit. */
  source: string;
}

export interface GcpBillingSource {
  readonly realism: Realism;
  listSkus(serviceId: string): Promise<GcpSkusResult>;
}

export interface LiveGcpBillingSourceOptions {
  fetchImpl?: FetchLike;
  cache?: FsCache;
}

/**
 * Real, typed client for the Cloud Billing Catalog API. Fully functional —
 * paginates on `nextPageToken` exactly like the AWS/Azure live clients — but
 * requires an API key (or, with a differently-scoped fetchImpl, ADC/OAuth),
 * since there is no public unauthenticated equivalent for this API
 * (confirmed: an unauthenticated call 403s with "doesn't allow unregistered
 * callers"). Swapping a fixture-backed default for this live client, once a
 * key exists, is the only change needed anywhere in this adapter.
 */
export function createLiveGcpBillingSource(apiKey: string, opts: LiveGcpBillingSourceOptions = {}): GcpBillingSource {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const cache = opts.cache ?? new FsCache();

  return {
    realism: "live",
    async listSkus(serviceId) {
      const skus: GcpSku[] = [];
      let pageToken: string | undefined;
      const firstUrl = skusUrl(serviceId);
      do {
        const url = skusUrl(serviceId, pageToken, apiKey);
        const page: GcpSkusListResponse = await cache.getOrFetch(url, async () => {
          const res = await fetchImpl(url);
          if (!res.ok) {
            throw new Error(`GET ${skusUrl(serviceId, pageToken)} failed: ${res.status} ${res.statusText}`);
          }
          return (await res.json()) as GcpSkusListResponse;
        });
        skus.push(...page.skus);
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
      return { skus, source: firstUrl };
    },
  };
}

/**
 * Fixture client: reads a small, hand-built (GCP requires auth, so this
 * cannot be a recorded live capture) JSON file matching the real
 * `services.skus.list` response shape. Filename convention: `<serviceId>.json`.
 */
export function createFixtureGcpBillingSource(fixtureDir: string): GcpBillingSource {
  return {
    realism: "fixture",
    async listSkus(serviceId) {
      const filePath = path.join(fixtureDir, `${serviceId}.json`);
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as GcpSkusListResponse;
      return { skus: data.skus, source: filePath };
    },
  };
}

function defaultFixtureDir(): string {
  return fileURLToPath(new URL("../../../../test/fixtures/gcp", import.meta.url));
}

export interface DefaultGcpBillingSourceOptions {
  apiKey?: string;
  fixtureDir?: string;
  fetchImpl?: FetchLike;
  cache?: FsCache;
}

/**
 * The swap point described in the task: live when a key is available
 * (`GOOGLE_API_KEY` env var, or explicitly passed), fixture otherwise. Every
 * caller of `getGcpPriceQuote` goes through this by default, so supplying a
 * real key later requires no code change.
 */
export function getDefaultGcpBillingSource(opts: DefaultGcpBillingSourceOptions = {}): GcpBillingSource {
  const apiKey = opts.apiKey ?? process.env["GOOGLE_API_KEY"];
  if (apiKey) {
    return createLiveGcpBillingSource(apiKey, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.cache ? { cache: opts.cache } : {}),
    });
  }
  return createFixtureGcpBillingSource(opts.fixtureDir ?? defaultFixtureDir());
}
