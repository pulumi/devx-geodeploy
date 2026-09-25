import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A small filesystem-backed cache for expensive upstream pricing calls (the AWS
// bulk offer files in particular run into the hundreds of megabytes). No Redis
// here — this environment has no Docker, and a TTL'd JSON-on-disk cache is all
// three adapters actually need. Every entry records when it was fetched so a
// `--refresh-pricing`-style force-bypass or a staleness audit is possible later.

export interface CacheEntry<T> {
  fetchedAt: string; // ISO timestamp
  value: T;
}

export interface FsCacheOptions {
  /** Directory entries are written to. Defaults to a fixed folder under the OS tmp dir. */
  dir?: string;
  /** Time-to-live in milliseconds before an entry is considered stale. Default 24h. */
  ttlMs?: number;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Approximate cap, in bytes, on the in-process memoization layer (LRU
   * evicted once exceeded). Default 512MB. This is a real, load-bearing
   * limit, not a nicety: one `FsCache` is now shared across an entire
   * `plan`/`price` run (see @geodeploy/cli's buildDefaultPricingSources) so
   * that repeated fetches for the same region reuse it — but AWS's EC2
   * offer file alone runs into the hundreds of MB, and a *catalog* of AWS
   * regions each has its own distinct one. Memoizing every one of them for
   * the life of the process, unbounded, crashed with "JavaScript heap out
   * of memory" on a real two-geo run (confirmed live). Bounding by
   * approximate size (not entry count) means many small Azure/GCP entries
   * can coexist without needlessly evicting each other, while a handful of
   * concurrently-active AWS region files stay bounded instead of
   * accumulating forever.
   */
  maxMemoryBytes?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MEMORY_BYTES = 512 * 1024 * 1024;

interface MemoEntry<T> {
  entry: CacheEntry<T>;
  /** Size of the entry's JSON-serialized form, in bytes — already computed as a side effect of reading/writing it, so tracking it here is free. */
  approxBytes: number;
}

function defaultCacheDir(): string {
  return process.env["GEODEPLOY_PRICING_CACHE_DIR"] ?? path.join(os.tmpdir(), "geodeploy-pricing-cache");
}

/** Deterministic, filesystem-safe filename for an arbitrary cache key (URLs, filter strings, ...). */
function keyToFilename(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

export class FsCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxMemoryBytes: number;
  // In-process memoization on top of the on-disk cache, bounded by
  // `maxMemoryBytes` (LRU-evicted — see FsCacheOptions.maxMemoryBytes for
  // why an unbounded version of this crashed a real run). Without this
  // layer entirely, every single `get()` call re-reads *and re-JSON.parses*
  // the full file from disk, even on a cache hit — verified live: pricing a
  // real multi-geo request without any memoization spent several CPU-minutes
  // doing nothing but repeatedly re-parsing the same already-cached file.
  // A `Map`'s insertion order doubles as LRU order here: touching a key
  // (get or set) deletes-then-reinserts it, so the least-recently-used
  // entry is always the first one `.keys().next()` yields.
  private readonly memory = new Map<string, MemoEntry<unknown>>();
  private memoryBytes = 0;
  // De-duplicates concurrent cache misses for the same key. The CLI
  // deliberately fetches multiple SKUs for the same region concurrently
  // (see packages/cli's fetchConcurrency), and every SKU in a region shares
  // the same underlying offer-file URL — without this, a cold cache lets N
  // concurrent callers all miss simultaneously and each kick off their own
  // redundant multi-hundred-MB download and parse.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: FsCacheOptions = {}) {
    this.dir = opts.dir ?? defaultCacheDir();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxMemoryBytes = opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  }

  private filePath(key: string): string {
    return path.join(this.dir, keyToFilename(key));
  }

  private isFresh(fetchedAt: string): boolean {
    const ageMs = this.now() - Date.parse(fetchedAt);
    return Number.isFinite(ageMs) && ageMs <= this.ttlMs;
  }

  /** Records/refreshes an entry's recency and evicts the least-recently-used entries until back under budget. */
  private rememberInMemory<T>(key: string, entry: CacheEntry<T>, approxBytes: number): void {
    const existing = this.memory.get(key);
    if (existing) this.memoryBytes -= existing.approxBytes;
    this.memory.delete(key);
    this.memory.set(key, { entry, approxBytes });
    this.memoryBytes += approxBytes;

    // `size > 1` guard: never evict the only entry left, even if it alone
    // exceeds the budget — better to temporarily exceed it than to discard
    // the one thing that would otherwise immediately be re-fetched.
    while (this.memoryBytes > this.maxMemoryBytes && this.memory.size > 1) {
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.memory.get(oldestKey);
      this.memory.delete(oldestKey);
      if (oldest) this.memoryBytes -= oldest.approxBytes;
    }
  }

  /** Reads a memoized entry (if present) and bumps its recency, without checking freshness. */
  private touchMemory(key: string): MemoEntry<unknown> | undefined {
    const existing = this.memory.get(key);
    if (!existing) return undefined;
    this.memory.delete(key);
    this.memory.set(key, existing);
    return existing;
  }

  /** Returns the cached value, or undefined if missing, corrupt, or past its TTL. */
  async get<T>(key: string): Promise<T | undefined> {
    const memoized = this.touchMemory(key) as MemoEntry<T> | undefined;
    if (memoized) {
      if (this.isFresh(memoized.entry.fetchedAt)) return memoized.entry.value;
      this.memory.delete(key);
      this.memoryBytes -= memoized.approxBytes;
    }

    try {
      const raw = await readFile(this.filePath(key), "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (!this.isFresh(entry.fetchedAt)) {
        return undefined;
      }
      this.rememberInMemory(key, entry, raw.length);
      return entry.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: CacheEntry<T> = { fetchedAt: new Date(this.now()).toISOString(), value };
    const raw = JSON.stringify(entry);
    this.rememberInMemory(key, entry, raw.length);
    await writeFile(this.filePath(key), raw, "utf8");
  }

  /**
   * Returns the cached value if fresh; otherwise calls `fetcher` exactly
   * once even under concurrent callers, caches the result, and returns it.
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const value = await fetcher();
        await this.set(key, value);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}
