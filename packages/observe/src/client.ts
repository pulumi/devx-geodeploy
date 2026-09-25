import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { GoogleAuth } from "google-auth-library";
import type { RegionPlan } from "@geodeploy/core";

const METRICS_GROUP = "metrics.k8s.io";
const METRICS_VERSION = "v1beta1";
const METRICS_PODS_PLURAL = "pods";

/**
 * One region's raw metrics sample -- deliberately not the full
 * `RegionUtilization` shape: `geoId`, `cpuAllocatableCores`/`cpuUtilPct`
 * (which need `RegionPlan.nodesNeeded` + a vcpu-per-sku lookup) and
 * `nodeCount` (the Metrics API's pod-scoped endpoint carries no node
 * identity) are only knowable one level up, in `collectUtilization`.
 */
export interface RegionMetricsSample {
  observedAt: string;
  cpuUsedCores: number;
  podCount: number;
}

export interface RegionMetricsClient {
  queryUtilization(): Promise<RegionMetricsSample>;
}

/**
 * The minimal slice of `@kubernetes/client-node`'s `CustomObjectsApi` this
 * package depends on -- kept small (rather than the full generated class) so
 * tests can inject a fixture-based fake without touching a real cluster or
 * the `@kubernetes/client-node` module at all. The real
 * `kc.makeApiClient(CustomObjectsApi)` result satisfies this shape.
 */
export interface CustomObjectsApiLike {
  listClusterCustomObject(params: { group: string; version: string; plural: string }): Promise<unknown>;
}

/** Races a promise against a timeout -- mirrors `packages/detect/src/tier2.ts`'s `withTimeout` helper. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`observe client call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const GCP_TOKEN_TIMEOUT_MS = 2000;

/** Mints a fresh GCP OAuth access token -- same pattern as `packages/detect/src/tier2.ts`'s `verifyGcpIdentity`. */
export async function mintGcpAccessToken(): Promise<string> {
  const auth = new GoogleAuth();
  const client = await withTimeout(auth.getClient(), GCP_TOKEN_TIMEOUT_MS);
  const accessToken = await withTimeout(client.getAccessToken(), GCP_TOKEN_TIMEOUT_MS);
  if (!accessToken?.token) {
    throw new Error("google-auth-library returned no access token");
  }
  return accessToken.token;
}

/**
 * The GKE-recorded kubeconfig (see `clusterGcpGke`) embeds a short-lived
 * (~1hr) OAuth token as `users[0].user.token` that never refreshes on
 * replay. Rather than string-patching the raw kubeconfig before parsing,
 * this replaces the parsed `User` entry after `loadFromString` -- `User`'s
 * fields are `readonly`, so the array entry is swapped for a new object
 * rather than mutated in place.
 */
function applyGcpTokenOverride(kc: KubeConfig, freshToken: string): void {
  const currentUser = kc.getCurrentUser();
  if (!currentUser) {
    throw new Error("kubeconfig has no current user to apply the refreshed GCP token to");
  }
  const idx = kc.users.findIndex((u) => u.name === currentUser.name);
  if (idx === -1) {
    throw new Error(`kubeconfig user "${currentUser.name}" not found in its own users list`);
  }
  kc.users[idx] = { ...currentUser, token: freshToken };
}

/**
 * Parses a Kubernetes CPU "quantity" string (as returned by the Metrics API's
 * `usage.cpu`, e.g. `"250m"`, `"1500m"`, `"2"`, `"500000n"`) into whole cores.
 * CPU quantities only ever use the binary-fraction-free decimal SI suffixes
 * `n` (nano, 1e-9), `u` (micro, 1e-6) and `m` (milli, 1e-3), or no suffix at
 * all for whole/fractional cores -- unlike memory quantities, they never use
 * `Ki`/`Mi`/`Gi` or `k`/`M`/`G`.
 */
export function parseCpuQuantity(raw: string): number {
  const trimmed = raw.trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/.exec(trimmed);
  if (!match) {
    throw new Error(`unrecognized Kubernetes CPU quantity: "${raw}"`);
  }
  const [, numeric, suffix] = match;
  const value = Number(numeric);
  switch (suffix) {
    case "n":
      return value * 1e-9;
    case "u":
      return value * 1e-6;
    case "m":
      return value * 1e-3;
    default:
      return value;
  }
}

interface RawPodMetricsContainer {
  usage?: { cpu?: unknown };
}
interface RawPodMetricsItem {
  containers?: RawPodMetricsContainer[];
}
interface RawPodMetricsList {
  items?: RawPodMetricsItem[];
}

function extractPodMetricsItems(body: unknown): RawPodMetricsItem[] {
  const list = body as RawPodMetricsList | undefined;
  if (!list || !Array.isArray(list.items)) {
    throw new Error("metrics.k8s.io pods response did not include an \"items\" array");
  }
  return list.items;
}

/**
 * Queries the aggregated Metrics API's `pods` endpoint and sums per-container
 * CPU usage into a single region-wide sample.
 *
 * Cluster-scoped (`listClusterCustomObject`), not namespace-scoped
 * (`listNamespacedCustomObject`): `workloadK8sManifest` applies the user's
 * raw manifest verbatim, so GeoDeploy has no fixed namespace it can assume
 * the workload lands in -- a namespaced query would silently miss workloads
 * deployed outside the one namespace guessed at.
 */
export async function queryRegionPodMetrics(
  api: CustomObjectsApiLike,
  now: () => Date = () => new Date(),
): Promise<RegionMetricsSample> {
  const body = await api.listClusterCustomObject({
    group: METRICS_GROUP,
    version: METRICS_VERSION,
    plural: METRICS_PODS_PLURAL,
  });
  const items = extractPodMetricsItems(body);

  let cpuUsedCores = 0;
  for (const item of items) {
    for (const container of item.containers ?? []) {
      const cpu = container.usage?.cpu;
      if (typeof cpu === "string") {
        cpuUsedCores += parseCpuQuantity(cpu);
      }
    }
  }

  return { observedAt: now().toISOString(), cpuUsedCores, podCount: items.length };
}

export interface MetricsClientOptions {
  /** Test seam: overrides how a fresh GCP access token is minted. Defaults to the real `google-auth-library` path. */
  mintGcpAccessToken?: () => Promise<string>;
  /** Test seam: overrides how the `CustomObjectsApi` client is constructed from the loaded `KubeConfig`. */
  makeCustomObjectsApi?: (kc: KubeConfig) => CustomObjectsApiLike;
  /** Test seam: overrides the clock used to stamp `observedAt`. */
  now?: () => Date;
}

/**
 * Builds a metrics client for one region from its recorded kubeconfig
 * string. For GCP, the recorded token is refreshed in-memory before any
 * query is issued -- see `applyGcpTokenOverride`. AWS's exec-plugin
 * kubeconfig and Azure's static cert/token both refresh (or simply remain
 * valid) on their own, so no override is needed for those providers.
 */
export async function metricsClientForRegion(
  regionPlan: RegionPlan,
  kubeconfigString: string,
  opts: MetricsClientOptions = {},
): Promise<RegionMetricsClient> {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfigString);

  if (regionPlan.provider === "gcp") {
    const mint = opts.mintGcpAccessToken ?? mintGcpAccessToken;
    const freshToken = await mint();
    applyGcpTokenOverride(kc, freshToken);
  }

  const makeApi = opts.makeCustomObjectsApi ?? ((config) => config.makeApiClient(CustomObjectsApi));
  const api = makeApi(kc);
  const now = opts.now ?? (() => new Date());

  return {
    queryUtilization: () => queryRegionPodMetrics(api, now),
  };
}
