import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Realism } from "@geodeploy/core";
import { FsCache } from "../cache.js";
import { defaultFetch, fetchJson, type FetchLike } from "../http.js";
import { offerFileUrl, regionIndexUrl, type AwsServiceCode } from "./constants.js";
import type { AwsOfferFile, AwsRegionIndex } from "./types.js";

export interface AwsOfferFileResult {
  data: AwsOfferFile;
  /** Exact URL fetched (live) or fixture file path (fixture), for audit. */
  source: string;
}

// Decouples "how do I get the offer file for this service+region" from the
// parser, so the exact same parsing code runs against a real, live download
// or a small recorded fixture with zero branching in the parser itself.
export interface AwsOfferSource {
  readonly realism: Realism;
  fetchOfferFile(serviceCode: AwsServiceCode, region: string): Promise<AwsOfferFileResult>;
}

export interface LiveAwsOfferSourceOptions {
  fetchImpl?: FetchLike;
  cache?: FsCache;
}

/**
 * Real client: resolves the per-region offer file URL via `region_index.json`,
 * then downloads and parses the (large — the AmazonEC2 file runs several
 * hundred MB) offer file. Buffered with a single JSON.parse rather than
 * streamed; measured at ~3s / ~750MB RSS for the full AmazonEC2 file in this
 * environment, which is acceptable for a once-per-TTL background refresh but
 * is a known spot to swap in a streaming JSON parser (e.g. `stream-json`) if
 * this ever needs to run somewhere memory-constrained.
 */
export function createLiveAwsOfferSource(opts: LiveAwsOfferSourceOptions = {}): AwsOfferSource {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const cache = opts.cache ?? new FsCache();

  return {
    realism: "live",
    async fetchOfferFile(serviceCode, region) {
      const regionIndex = await cache.getOrFetch(regionIndexUrl(serviceCode), () =>
        fetchJson<AwsRegionIndex>(fetchImpl, regionIndexUrl(serviceCode)),
      );
      const entry = regionIndex.regions[region];
      if (!entry) {
        throw new Error(`AWS ${serviceCode}: no region_index entry for region "${region}"`);
      }
      const url = offerFileUrl(entry.currentVersionUrl);
      const data = await cache.getOrFetch(url, () => fetchJson<AwsOfferFile>(fetchImpl, url));
      return { data, source: url };
    },
  };
}

const FIXTURE_FILENAMES: Record<AwsServiceCode, string> = {
  AmazonEC2: "ec2",
  AmazonEKS: "eks",
  AWSDataTransfer: "datatransfer",
  AWSELB: "elb",
};

/**
 * Fixture client: reads a small, trimmed, recorded offer-file JSON from disk
 * instead of hitting the network. Filenames follow the convention
 * `<service-slug>-<region>.json` (e.g. `ec2-us-east-1.json`).
 */
export function createFixtureAwsOfferSource(fixtureDir: string): AwsOfferSource {
  return {
    realism: "fixture",
    async fetchOfferFile(serviceCode, region) {
      const filePath = path.join(fixtureDir, `${FIXTURE_FILENAMES[serviceCode]}-${region}.json`);
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as AwsOfferFile;
      return { data, source: filePath };
    },
  };
}
