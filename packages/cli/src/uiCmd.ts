import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  ApplyRecordSchema,
  DeploymentPlanSchema,
  DeploymentRequestSchema,
  MonitorRecordSchema,
  type DeploymentPlan,
  type WorkloadSpec,
} from "@geodeploy/core";
import { checkApplyReadiness, type RegionProvisionStatus } from "@geodeploy/provision";
import type { ComposeConfig, ComposeDnsConfig, ComposeIngressConfig } from "@geodeploy/compose";
import { knownGeoIds } from "@geodeploy/geo";
import { applyPendingResize, writeMonitorModeControl } from "./monitorCmd.js";
import { resolveGeoIds } from "./request.js";
import { runPlanFromRequest, type RunPlanResult } from "./planCmd.js";
import { runApply } from "./applyCmd.js";
import type { BuildPriceGroupsOptions } from "./pricingPipeline.js";

const require = createRequire(import.meta.url);

// Minimal extension -> MIME lookup, enough for a Vite-built SPA (HTML, JS,
// CSS, source maps, fonts, and the odd image); anything unrecognized falls
// back to a generic binary content-type rather than guessing wrong.
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function mimeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface RunUiOptions {
  /** Directory containing `plan.json`/`apply.json` (and watched for live updates). */
  dir: string;
  /** Port to listen on. */
  port: number;
  /**
   * Overrides the auto-detected `@geodeploy/web` `dist/` directory used for
   * static file serving. Not needed/used by the `ui` CLI command itself —
   * exists so tests can exercise the "built" vs. "not yet built" static
   * serving paths deterministically, independent of whether the real
   * `@geodeploy/web` package has actually been built in this checkout.
   */
  staticDir?: string;
  /**
   * Test-only override for `POST /api/plan`'s pricing sources — real usage
   * (the `ui` CLI command) always uses live/default sources; tests inject
   * fixture-backed ones here so wizard submissions stay offline and fast,
   * the same way `packages/cli`'s own e2e test does for the `plan` command.
   */
  pricingOpts?: BuildPriceGroupsOptions;
  /**
   * Path to the `Record<geoId, ComposeConfig>` JSON file `POST /api/resize/apply`
   * applies against. Defaults to `<dir>/config.json`, colocated with
   * `plan.json`/`apply.json`/`monitor.json` — the same file a `geodeploy
   * monitor --config <path>` invocation targeting this directory was itself
   * started with.
   */
  configPath?: string;
}

export interface RunUiResult {
  url: string;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// plan.json / apply.json loading — shared by the one-shot GET endpoints and
// the SSE push path, so both ever only ever report one of three states:
// absent, valid, or "present but failed to parse/validate" (never a 500 for
// a transient mid-write read, per the API contract).
// ---------------------------------------------------------------------------

type FileState<T> = { value: T | null; error?: string };

async function loadJsonFile<T>(
  filePath: string,
  parse: (raw: unknown) => T,
): Promise<FileState<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: null };
    }
    return { value: null, error: `failed to read ${path.basename(filePath)}: ${(err as Error).message}` };
  }

  try {
    return { value: parse(JSON.parse(raw)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: null, error: `${path.basename(filePath)} exists but failed to parse: ${message}` };
  }
}

async function loadPlan(dir: string): Promise<FileState<unknown>> {
  return loadJsonFile(path.join(dir, "plan.json"), (raw) => DeploymentPlanSchema.parse(raw));
}

async function loadApply(dir: string): Promise<FileState<unknown>> {
  return loadJsonFile(path.join(dir, "apply.json"), (raw) => ApplyRecordSchema.parse(raw));
}

async function loadMonitor(dir: string): Promise<FileState<unknown>> {
  return loadJsonFile(path.join(dir, "monitor.json"), (raw) => MonitorRecordSchema.parse(raw));
}

// ---------------------------------------------------------------------------
// SSE fan-out
// ---------------------------------------------------------------------------

interface SseClient {
  res: http.ServerResponse;
}

function sendSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function sendPlanEvent(clients: Set<SseClient>, dir: string): Promise<void> {
  const state = await loadPlan(dir);
  const event = state.value === null && !state.error ? "plan-missing" : "plan";
  const payload = state.error ? { plan: null, error: state.error } : { plan: state.value };
  for (const client of clients) sendSse(client.res, event, payload);
}

async function sendApplyEvent(clients: Set<SseClient>, dir: string): Promise<void> {
  const state = await loadApply(dir);
  const event = state.value === null && !state.error ? "apply-missing" : "apply";
  const payload = state.error ? { apply: null, error: state.error } : { apply: state.value };
  for (const client of clients) sendSse(client.res, event, payload);
}

async function sendMonitorEvent(clients: Set<SseClient>, dir: string): Promise<void> {
  const state = await loadMonitor(dir);
  const event = state.value === null && !state.error ? "monitor-missing" : "monitor";
  const payload = state.error ? { monitor: null, error: state.error } : { monitor: state.value };
  for (const client of clients) sendSse(client.res, event, payload);
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/plan — the wizard's "generate a real plan" endpoint
// ---------------------------------------------------------------------------

// Matches examples/sample-request.json's shape, so a wizard submission with
// no workload overrides behaves the same as the project's own example.
const DEFAULT_WORKLOAD: WorkloadSpec = {
  manifests: ["k8s/deployment.yaml", "k8s/service.yaml"],
  replicasPerRegion: 2,
  requestsPerPod: { vcpu: 1, memGiB: 2 },
  egressGiBPerMonth: 50,
  storageGiB: 20,
};

// The k8s-level Service selector/ports a real `geodeploy apply` needs
// (ingressK8sServiceLb's config, packages/modules/src/ingress/service-lb.ts)
// -- a different, deploy-time-only concern from the ingress *posture*
// (public-alb/waf-fronted/internal-only) TypeSafe/the fallback decides.
// Applied identically to every region in the plan, same as `workload`: one
// plan is one workload spread across regions, never a different Service
// shape per region.
const DEFAULT_INGRESS: ComposeIngressConfig = {
  selector: { app: "demo" },
  ports: [{ port: 80, targetPort: 80 }],
};

interface WizardDnsInput {
  recordName: string;
  route53ZoneId: string;
}

interface WizardPlanRequest {
  image: { reference: string; platforms: string[]; buildContextId?: string };
  targetGeoIds: string[];
  workload?: Partial<WorkloadSpec>;
  ingress?: ComposeIngressConfig;
  dns?: WizardDnsInput;
}

function isValidIngress(value: unknown): value is ComposeIngressConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const selector = v["selector"];
  const ports = v["ports"];
  if (typeof selector !== "object" || selector === null) return false;
  if (!Object.values(selector).every((val) => typeof val === "string")) return false;
  if (!Array.isArray(ports) || ports.length === 0) return false;
  return ports.every((p) => {
    if (typeof p !== "object" || p === null) return false;
    const port = p as Record<string, unknown>;
    return typeof port["port"] === "number" && (typeof port["targetPort"] === "number" || typeof port["targetPort"] === "string");
  });
}

function isValidDns(value: unknown): value is WizardDnsInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["recordName"] === "string" &&
    v["recordName"].length > 0 &&
    typeof v["route53ZoneId"] === "string" &&
    v["route53ZoneId"].length > 0
  );
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function isWizardPlanRequest(body: unknown): body is WizardPlanRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  const image = b["image"] as Record<string, unknown> | undefined;
  return (
    typeof image === "object" &&
    image !== null &&
    typeof image["reference"] === "string" &&
    Array.isArray(image["platforms"]) &&
    Array.isArray(b["targetGeoIds"]) &&
    (b["ingress"] === undefined || isValidIngress(b["ingress"])) &&
    (b["dns"] === undefined || isValidDns(b["dns"]))
  );
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Runs the *identical* pipeline `geodeploy plan` does (via
 * `runPlanFromRequest`, shared with the CLI — never a reimplementation),
 * against a `DeploymentRequest` assembled from the wizard's simpler input.
 * Writes `plan.json`/`plan.md` into `dir` on success — the same directory
 * the SSE watcher above already watches, so a successful wizard submission
 * needs no additional live-update wiring: the file write is what pushes it.
 * Blocks until real computation finishes (this can take anywhere from
 * ~30s to several minutes, dominated by AWS's large offer-file parsing —
 * confirmed live); Node's plain `http.Server` has no default request
 * timeout, so a long-lived response here is fine as-is.
 *
 * Also writes `config.json` (the `Record<geoId, ComposeConfig>` `geodeploy
 * apply` needs) alongside `plan.json` — before this, `config.json` had no UI
 * path at all and had to be hand-authored. `workloadManifestFiles` reuses
 * the same `workload.manifests` this request already validated (previously
 * collected by the wizard but never actually wired to apply-time config);
 * `ingress` is the wizard's new selector/ports input, or `DEFAULT_INGRESS`
 * if omitted. Both are applied identically to every region in the resulting
 * plan, same as the underlying `workload` itself.
 *
 * Optionally also wires a `dns` section per region when `body.dns` (record
 * name + Route53 hosted zone id) is provided — Route53-only, since that's
 * the only DNS backend this form collects config for. If the plan's own
 * decision engine picked a DNS provider but no matching config was
 * supplied, the response carries a `dnsWarning` instead of silently letting
 * the gap surface only once a real `apply` fails on it later.
 */
async function handlePlanSubmission(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dir: string,
  pricingOpts?: BuildPriceGroupsOptions,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!isWizardPlanRequest(body)) {
    sendJson(res, 400, {
      error: 'body must be { image: { reference: string, platforms: string[] }, targetGeoIds: string[], workload? }',
    });
    return;
  }

  let targetGeos;
  try {
    targetGeos = resolveGeoIds(body.targetGeoIds);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let request;
  try {
    request = DeploymentRequestSchema.parse({
      targetGeos,
      image: {
        reference: body.image.reference,
        platforms: body.image.platforms,
        ...(body.image.buildContextId ? { buildContextId: body.image.buildContextId } : {}),
      },
      workload: { ...DEFAULT_WORKLOAD, ...body.workload },
      constraints: { maxProviders: 2 },
    });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let result: RunPlanResult;
  try {
    result = await runPlanFromRequest(request, dir, pricingOpts);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const ingress = body.ingress ?? DEFAULT_INGRESS;
  const configByGeo: Record<string, ComposeConfig> = {};
  for (const region of result.plan.regions) {
    // Route53 requires one AWS region id per latency-routing record
    // (dnsAwsRoute53's own doc comment) -- only meaningful when this
    // specific region's compute is actually on AWS; for a non-AWS region
    // sharing the same Route53-backed plan, omit it and let the module fall
    // back to its own documented default rather than pass it a region id
    // Route53 wouldn't recognize.
    const dns: ComposeDnsConfig | undefined = body.dns
      ? {
          recordName: body.dns.recordName,
          routingPolicy: "latency",
          route53: { zoneId: body.dns.route53ZoneId },
          ...(region.provider === "aws" ? { routingKey: region.region } : {}),
        }
      : undefined;
    configByGeo[region.geoId] = {
      workloadManifestFiles: request.workload.manifests,
      ingress,
      ...(dns ? { dns } : {}),
    };
  }
  await writeFile(path.join(dir, "config.json"), JSON.stringify(configByGeo, null, 2), "utf8");

  // This plan's own decision engine picked a DNS provider (based on real
  // credentials present at plan time), but the wizard request didn't supply
  // the config apply-time DNS wiring actually needs -- surfaced as a warning
  // now, before the user discovers it only when Deploy fails minutes into a
  // real apply. Only route53 is supported by this wizard today (ns1/cloudflare
  // plans still require a hand-authored config.json, same as before this feature).
  const dnsWarning =
    result.plan.dns.provider !== null && !body.dns
      ? `This plan selected "${result.plan.dns.provider}" for DNS, but no DNS config was provided — deploying will fail until you set a record name and Route53 hosted zone ID (only route53 is supported by this form today).`
      : result.plan.dns.provider !== null && result.plan.dns.provider !== "route53" && body.dns
        ? `This plan selected "${result.plan.dns.provider}" for DNS, not route53 — the DNS config you provided won't be used; deploying will fail until this plan is regenerated with route53-capable credentials, or config.json is hand-authored for "${result.plan.dns.provider}".`
        : undefined;

  sendJson(res, 200, { plan: result.plan, ...(dnsWarning ? { dnsWarning } : {}) });
}

// ---------------------------------------------------------------------------
// POST /api/build-context, GET /api/build-context/:id — the wizard's "upload
// a whole project folder, not just a Dockerfile" endpoints. The client
// base64-encodes every file into one JSON body (reusing readJsonBody/sendJson
// rather than adding a multipart-parsing dependency); the server decodes and
// writes them under <dir>/build-context/<id>/, so a real build context is
// durably captured on disk for a possible future real-build step (not
// implemented here — see packages/modules/src/image/multiarch.ts, dormant).
// ---------------------------------------------------------------------------

const MAX_BUILD_CONTEXT_BYTES = 50 * 1024 * 1024;
const MAX_BUILD_CONTEXT_FILES = 2000;
const DOCKERFILE_PATTERN = /(^|\/)Dockerfile(\.\w+)?$/i;

interface BuildContextFileInput {
  path: string;
  contentBase64: string;
}

function isBuildContextUploadBody(body: unknown): body is { files: BuildContextFileInput[] } {
  if (typeof body !== "object" || body === null) return false;
  const files = (body as Record<string, unknown>)["files"];
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as Record<string, unknown>)["path"] === "string" &&
      typeof (f as Record<string, unknown>)["contentBase64"] === "string",
  );
}

/**
 * Rejects absolute paths, `..` segments, and backslashes outright, then
 * independently re-verifies the resolved path stays under `baseDir` — two
 * checks rather than one, since path-traversal defenses are exactly the kind
 * of thing worth not trusting a single layer of.
 */
function safeJoinUnderBaseDir(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.includes("\\")) {
    throw new Error(`unsafe path in upload: "${relativePath}"`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  const resolvedBase = path.resolve(baseDir);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`unsafe path in upload: "${relativePath}"`);
  }
  return resolved;
}

/** Shallowest (fewest path segments) Dockerfile-matching path, or null. Mirrors packages/web/src/folderUpload.ts's findDockerfilePath — same rule, independent implementations (different runtimes, no shared package for a five-line pure function). */
function findDockerfilePath(paths: readonly string[]): string | null {
  const candidates = paths.filter((p) => DOCKERFILE_PATTERN.test(p));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.split("/").length - b.split("/").length)[0]!;
}

async function handleBuildContextUpload(req: http.IncomingMessage, res: http.ServerResponse, dir: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!isBuildContextUploadBody(body)) {
    sendJson(res, 400, { error: "body must be { files: Array<{ path: string, contentBase64: string }> } (non-empty)" });
    return;
  }

  if (body.files.length > MAX_BUILD_CONTEXT_FILES) {
    sendJson(res, 400, { error: `too many files: ${body.files.length} (max ${MAX_BUILD_CONTEXT_FILES})` });
    return;
  }

  const dockerfilePath = findDockerfilePath(body.files.map((f) => f.path));
  if (!dockerfilePath) {
    sendJson(res, 400, { error: "no Dockerfile found anywhere in the uploaded folder" });
    return;
  }

  let decoded: Array<{ targetPath: string; buffer: Buffer }>;
  let totalBytes = 0;
  const buildContextId = randomUUID();
  const contextDir = path.join(dir, "build-context", buildContextId);
  try {
    decoded = body.files.map((f) => {
      const buffer = Buffer.from(f.contentBase64, "base64");
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_BUILD_CONTEXT_BYTES) {
        throw new Error(`upload exceeds the ${MAX_BUILD_CONTEXT_BYTES / (1024 * 1024)}MB total size limit`);
      }
      return { targetPath: safeJoinUnderBaseDir(contextDir, f.path), buffer };
    });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  for (const { targetPath, buffer } of decoded) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, buffer);
  }

  sendJson(res, 200, { buildContextId, dockerfilePath, fileCount: decoded.length, totalBytes });
}

async function listFilesRecursively(baseDir: string, subDir = ""): Promise<string[]> {
  const entries = await readdir(path.join(baseDir, subDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = subDir ? `${subDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(baseDir, relPath)));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

async function handleBuildContextList(res: http.ServerResponse, dir: string, buildContextId: string): Promise<void> {
  const contextDir = path.join(dir, "build-context", buildContextId);
  try {
    const files = await listFilesRecursively(contextDir);
    sendJson(res, 200, { files });
  } catch {
    sendJson(res, 404, { error: `no build context found with id "${buildContextId}"` });
  }
}

export async function runUi(opts: RunUiOptions): Promise<RunUiResult> {
  const dir = opts.dir;

  // Located lazily (not at module load) so a missing @geodeploy/web/dist
  // never prevents the server itself from starting — only static serving
  // degrades. `opts.staticDir` (test-only) bypasses auto-detection entirely.
  let staticDir: string | null = opts.staticDir ?? null;
  if (staticDir === null) {
    try {
      const webPkgPath = require.resolve("@geodeploy/web/package.json");
      staticDir = path.join(path.dirname(webPkgPath), "dist");
    } catch {
      staticDir = null;
    }
  }

  const clients = new Set<SseClient>();

  // In-memory only (never persisted) — live progress for a currently-running
  // apply, cleared the moment it finishes. `apply.json` remains the durable
  // record of the *outcome*; this is purely ephemeral "what's happening
  // right now" for the UI's Deploy panel, capped so a very long apply can't
  // grow this unboundedly (same concern as the earlier monitor.json growth
  // investigation, addressed here up front instead of discovered later).
  const MAX_APPLY_PROGRESS_LINES = 500;
  let applyInFlight: {
    regionStatus: Record<string, RegionProvisionStatus>;
    lines: Array<{ geoId: string; text: string; at: string }>;
  } | null = null;

  // One fs.watch watcher for the whole server lifetime (not per-SSE-client),
  // debounced because editors/writers can emit multiple rapid `change`
  // events for one logical write; fanned out to every connected client.
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pendingFiles = new Set<string>();

  function scheduleDispatch(filename: string): void {
    pendingFiles.add(filename);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const files = pendingFiles;
      pendingFiles = new Set();
      debounceTimer = null;
      for (const f of files) {
        if (f === "plan.json") void sendPlanEvent(clients, dir);
        if (f === "apply.json") void sendApplyEvent(clients, dir);
        if (f === "monitor.json") void sendMonitorEvent(clients, dir);
      }
    }, 75);
  }

  if (await dirExists(dir)) {
    watcher = watch(dir, (_eventType, filename) => {
      if (filename === "plan.json" || filename === "apply.json" || filename === "monitor.json") {
        scheduleDispatch(filename);
      }
    });
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    if (pathname === "/api/plan" && req.method === "POST") {
      await handlePlanSubmission(req, res, dir, opts.pricingOpts);
      return true;
    }

    if (pathname === "/api/build-context" && req.method === "POST") {
      await handleBuildContextUpload(req, res, dir);
      return true;
    }

    const buildContextMatch = /^\/api\/build-context\/([^/]+)$/.exec(pathname);
    if (buildContextMatch && req.method === "GET") {
      await handleBuildContextList(res, dir, buildContextMatch[1]!);
      return true;
    }

    if (pathname === "/api/plan") {
      const state = await loadPlan(dir);
      const body = state.error ? { plan: null, error: state.error } : { plan: state.value };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return true;
    }

    if (pathname === "/api/known-geos") {
      sendJson(res, 200, { geoIds: knownGeoIds() });
      return true;
    }

    if (pathname === "/api/apply" && req.method === "GET") {
      const state = await loadApply(dir);
      const body = state.error ? { apply: null, error: state.error } : { apply: state.value };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return true;
    }

    if (pathname === "/api/monitor") {
      const state = await loadMonitor(dir);
      const body = state.error ? { monitor: null, error: state.error } : { monitor: state.value };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return true;
    }

    if (pathname === "/api/monitor/mode" && req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const mode = (body as Record<string, unknown> | null)?.["mode"];
      if (mode !== "approval-gated" && mode !== "autonomous") {
        sendJson(res, 400, { error: 'body must be { mode: "approval-gated" | "autonomous" }' });
        return true;
      }
      // Only takes effect on the running `geodeploy monitor` process's next
      // poll (it re-reads this file each cycle — see monitorCmd.ts) — there
      // is no in-process monitor loop here to update immediately, `ui` and
      // `monitor` are separate processes coordinating only via files on disk.
      await writeMonitorModeControl(dir, mode);
      sendJson(res, 200, { mode });
      return true;
    }

    if (pathname === "/api/resize/apply" && req.method === "POST") {
      const configPath = opts.configPath ?? path.join(dir, "config.json");
      try {
        const result = await applyPendingResize({ planPath: path.join(dir, "plan.json"), monitorDir: dir, configPath });
        // plan.json/monitor.json/apply.json were all just (re)written by
        // applyPendingResize — the existing fs.watch debounce above picks
        // those up and re-broadcasts on its own, so no manual SSE send is
        // needed here beyond this direct response to the requester.
        sendJson(res, 200, { refused: result.refused, blockers: result.blockers });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // Non-blocking full-plan deploy trigger, distinct from `/api/resize/apply`
    // (which applies a much shorter-lived resize synchronously). A real EKS
    // apply can take 15-30 minutes, so this responds immediately — either
    // with an inline refusal (readiness/config checks are local and fast, no
    // reason to make the caller wait for those), or with `{ started: true }`
    // while the actual `runApply` call keeps running in the background,
    // streaming progress via the `applyProgress`/`applyProgressStatus` SSE
    // events below. The final outcome is `apply.json` itself, written by
    // `runApply` exactly as `geodeploy apply` writes it — the existing
    // fs.watch debounce picks that up and broadcasts the normal `apply`
    // event once it lands, superseding the transient progress shown here.
    if (pathname === "/api/apply" && req.method === "POST") {
      if (applyInFlight) {
        sendJson(res, 409, { error: "an apply is already in progress" });
        return true;
      }

      const planPath = path.join(dir, "plan.json");
      const configPath = opts.configPath ?? path.join(dir, "config.json");
      const planState = await loadPlan(dir);
      if (planState.value === null) {
        sendJson(res, 400, { error: planState.error ?? "no plan.json found" });
        return true;
      }

      const readiness = await checkApplyReadiness(planState.value as DeploymentPlan);
      if (!readiness.ready) {
        // Refused: fast enough to just await inline (mirrors runApply's own
        // refusal path, which writes apply.json but never touches Pulumi).
        const result = await runApply({ planPath, configPath, outDir: dir });
        sendJson(res, 200, { refused: true, blockers: result.blockers });
        return true;
      }

      applyInFlight = { regionStatus: {}, lines: [] };
      sendJson(res, 202, { started: true });

      void runApply({
        planPath,
        configPath,
        outDir: dir,
        onRegionOutput: (geoId, chunk) => {
          if (!applyInFlight) return;
          applyInFlight.lines.push({ geoId, text: chunk, at: new Date().toISOString() });
          if (applyInFlight.lines.length > MAX_APPLY_PROGRESS_LINES) applyInFlight.lines.shift();
          for (const client of clients) sendSse(client.res, "applyProgress", { geoId, chunk });
        },
        onRegionStatusChange: (geoId, status) => {
          if (!applyInFlight) return;
          applyInFlight.regionStatus[geoId] = status;
          for (const client of clients) sendSse(client.res, "applyProgressStatus", { geoId, status });
        },
      }).finally(() => {
        applyInFlight = null;
      });
      return true;
    }

    if (pathname === "/api/apply/progress") {
      sendJson(
        res,
        200,
        applyInFlight
          ? { inProgress: true, regionStatus: applyInFlight.regionStatus, lines: applyInFlight.lines }
          : { inProgress: false },
      );
      return true;
    }

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const client: SseClient = { res };
      clients.add(client);

      // Initial snapshot on connect.
      await sendPlanEvent(new Set([client]), dir);
      await sendApplyEvent(new Set([client]), dir);
      await sendMonitorEvent(new Set([client]), dir);
      if (applyInFlight) {
        sendSse(client.res, "applyProgressSnapshot", {
          regionStatus: applyInFlight.regionStatus,
          lines: applyInFlight.lines,
        });
      }

      req.on("close", () => {
        clients.delete(client);
      });
      return true;
    }

    return false;
  }

  async function handleStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    if (staticDir === null || !(await dirExists(staticDir))) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("@geodeploy/web has not been built yet — run `pnpm --filter @geodeploy/web build`\n");
      return;
    }

    const safeRelative = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidate = path.join(staticDir, safeRelative);

    let filePath = candidate;
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) {
        filePath = path.join(candidate, "index.html");
        await stat(filePath);
      }
    } catch {
      // Not a real file (or not found) — SPA fallback to index.html.
      filePath = path.join(staticDir, "index.html");
    }

    try {
      const data = await readFile(filePath);
      // Confirmed live: with no cache headers at all, a plain browser
      // refresh can keep serving a stale bundle even after the server's own
      // files are rebuilt — the exact same JS running twice made two
      // genuinely different fixes both look like "nothing changed". This is
      // a local, single-operator tool whose files change constantly during
      // active use, so correctness matters far more than cache performance —
      // never let the browser reuse a static response without asking again.
      res.writeHead(200, { "Content-Type": mimeFor(filePath), "Cache-Control": "no-store" });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`not found: ${(err as Error).message}\n`);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = decodeURIComponent(url.pathname);

        if (pathname.startsWith("/api/")) {
          const handled = await handleApi(req, res, pathname);
          if (!handled) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found\n");
          }
          return;
        }

        await handleStatic(res, pathname);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`internal error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  const url = `http://localhost:${port}`;

  const close = async (): Promise<void> => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
    for (const client of clients) {
      client.res.end();
    }
    clients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { url, close };
}
