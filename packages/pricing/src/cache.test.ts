import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsCache } from "./cache.js";

describe("FsCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-pricing-cache-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for a key that was never set", async () => {
    const cache = new FsCache({ dir });
    await expect(cache.get("missing")).resolves.toBeUndefined();
  });

  it("round-trips a value written with set", async () => {
    const cache = new FsCache({ dir });
    await cache.set("key", { hello: "world" });
    await expect(cache.get("key")).resolves.toEqual({ hello: "world" });
  });

  it("expires entries past the configured TTL", async () => {
    let clock = 1_000_000;
    const cache = new FsCache({ dir, ttlMs: 1000, now: () => clock });
    await cache.set("key", 42);
    // still within TTL
    clock += 500;
    await expect(cache.get("key")).resolves.toBe(42);
    // now past it
    clock += 1000;
    await expect(cache.get("key")).resolves.toBeUndefined();
  });

  it("getOrFetch calls the fetcher once and caches the result", async () => {
    const cache = new FsCache({ dir });
    const fetcher = vi.fn().mockResolvedValue("fetched-value");

    const first = await cache.getOrFetch("k", fetcher);
    const second = await cache.getOrFetch("k", fetcher);

    expect(first).toBe("fetched-value");
    expect(second).toBe("fetched-value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("getOrFetch re-fetches once the cached entry has expired", async () => {
    let clock = 0;
    const cache = new FsCache({ dir, ttlMs: 100, now: () => clock });
    const fetcher = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");

    await expect(cache.getOrFetch("k", fetcher)).resolves.toBe("v1");
    clock += 200;
    await expect(cache.getOrFetch("k", fetcher)).resolves.toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses a stable, filesystem-safe filename derived from the key", async () => {
    const cache = new FsCache({ dir });
    await cache.set("https://example.com/some/path?with=query&chars=/:*", "ok");
    await expect(cache.get("https://example.com/some/path?with=query&chars=/:*")).resolves.toBe("ok");
  });

  it("memoizes in-process: a value still resolves after the on-disk cache directory is gone", async () => {
    const cache = new FsCache({ dir });
    await cache.set("k", "big-value");
    await expect(cache.get("k")).resolves.toBe("big-value"); // populates the in-memory entry

    // Simulate the disk copy being unavailable entirely (a real re-read of a
    // hundreds-of-MB file would be far too slow to want a second time
    // anyway) — a correct implementation must still answer from memory.
    await rm(dir, { recursive: true, force: true });

    await expect(cache.get("k")).resolves.toBe("big-value");
  });

  it("a memoized entry still respects the TTL — memoization never bypasses expiry", async () => {
    let clock = 0;
    const cache = new FsCache({ dir, ttlMs: 100, now: () => clock });
    await cache.set("k", "v1");
    await expect(cache.get("k")).resolves.toBe("v1"); // populates the in-memory entry

    clock += 200; // past TTL
    await expect(cache.get("k")).resolves.toBeUndefined();
  });

  it("bounds in-process memory: the least-recently-used entry is evicted once the byte budget is exceeded", async () => {
    // Each entry serializes to ~250 bytes; a 600-byte budget fits two but not three.
    const cache = new FsCache({ dir, maxMemoryBytes: 600 });
    const big = (n: number) => `v${n}-` + "x".repeat(200);

    await cache.set("a", big(1));
    await cache.set("b", big(2));
    await cache.set("c", big(3)); // must push "a" (least recently used) out of memory

    // Delete the disk copies entirely — only whatever survived in memory can still resolve.
    await rm(dir, { recursive: true, force: true });

    await expect(cache.get("c")).resolves.toBe(big(3));
    await expect(cache.get("b")).resolves.toBe(big(2));
    await expect(cache.get("a")).resolves.toBeUndefined();
  });

  it("touching an entry via get() protects it from eviction as more-recently-used", async () => {
    const cache = new FsCache({ dir, maxMemoryBytes: 600 });
    const big = (n: number) => `v${n}-` + "x".repeat(200);

    await cache.set("a", big(1));
    await cache.set("b", big(2));
    await cache.get("a"); // bump "a" ahead of "b" in recency
    await cache.set("c", big(3)); // should now evict "b", the true least-recently-used

    await rm(dir, { recursive: true, force: true });

    await expect(cache.get("a")).resolves.toBe(big(1));
    await expect(cache.get("c")).resolves.toBe(big(3));
    await expect(cache.get("b")).resolves.toBeUndefined();
  });

  it("getOrFetch de-duplicates concurrent callers on a cold cache: the fetcher runs exactly once", async () => {
    const cache = new FsCache({ dir });
    const fetcher = vi.fn().mockResolvedValue("fetched-once");

    // Dispatched together so all three miss the (empty) cache before any of
    // them has resolved — the real-world case this protects against is N
    // concurrent SKU requests for the same region's offer file.
    const [a, b, c] = await Promise.all([
      cache.getOrFetch("k", fetcher),
      cache.getOrFetch("k", fetcher),
      cache.getOrFetch("k", fetcher),
    ]);

    expect([a, b, c]).toEqual(["fetched-once", "fetched-once", "fetched-once"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
