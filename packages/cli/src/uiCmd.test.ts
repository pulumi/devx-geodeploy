import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyRecord, DeploymentPlan } from "@geodeploy/core";
import { aws, azure } from "@geodeploy/pricing";
import { runUi, type RunUiResult } from "./uiCmd.js";

// Same fixture convention as e2e.test.ts: small, recorded (AWS/Azure)
// snapshots read straight off disk, so POST /api/plan tests stay fully
// offline and fast, exercising the real pipeline against real fixture data.
const AWS_FIXTURE_DIR = fileURLToPath(new URL("../../../test/fixtures/aws", import.meta.url));
const AZURE_FIXTURE_DIR = fileURLToPath(new URL("../../../test/fixtures/azure", import.meta.url));

function fixturePricingOptions() {
  return {
    sources: {
      awsSource: aws.createFixtureAwsOfferSource(AWS_FIXTURE_DIR),
      azureSource: azure.createFixtureAzureRetailPriceSource(AZURE_FIXTURE_DIR),
    },
    onSkuWarning: () => {},
  };
}

function samplePlan(): DeploymentPlan {
  return {
    requestId: "plan-1",
    createdAt: "2026-09-16T00:00:00.000Z",
    regions: [
      {
        geoId: "eu-central",
        provider: "azure",
        region: "westeurope",
        sku: "Standard_D2s_v5",
        centroid: { lat: 52.3676, lon: 4.9041 },
        demandCentroid: { lat: 50.1109, lon: 8.6821 },
        nodesNeeded: 2,
        monthlyUsd: 200,
        provisionable: false,
        modules: {
          cluster: "cluster.azure.aks",
          registry: "registry.azure.acr",
          ingress: "ingress.k8s.service-lb",
          autoscaling: "autoscaling.cluster-autoscaler-conservative",
          sizing: "sizing.xs",
        },
      },
    ],
    dns: { provider: null, reason: "no dns backend usable" },
    totalMonthlyUsd: 200,
    decisionRecords: [
      {
        geoId: "eu-central",
        kind: "geo-selection",
        mode: "deterministic-fallback",
        selection: { provider: "azure", region: "westeurope" },
        reason: "Deterministic fallback: chose azure:westeurope at $200.00/mo.",
      },
    ],
    allowedProviders: ["aws", "azure", "gcp"],
    detectedProviders: [],
    notes: [],
  };
}

function sampleApply(): ApplyRecord {
  return {
    requestId: "plan-1",
    checkedAt: "2026-09-16T00:00:00.000Z",
    refused: true,
    blockers: ["no credentials"],
  };
}

function sampleMonitorRecord(applied: boolean) {
  const plan = samplePlan();
  const updatedRegions = plan.regions.map((r) => (r.geoId === "eu-central" ? { ...r, nodesNeeded: 3 } : r));
  const resize = {
    requestId: plan.requestId,
    createdAt: "2026-09-17T00:00:00.000Z",
    utilization: { requestId: plan.requestId, collectedAt: "2026-09-17T00:00:00.000Z", regions: [] },
    actions: [{ geoId: "eu-central", action: "scale-up" as const, newNodesNeeded: 3 }],
    updatedRegions,
    decisionRecords: [],
    confidencePassed: false,
    mode: "approval-gated" as const,
    applied,
    reason: "test fixture",
  };
  return {
    requestId: plan.requestId,
    mode: "approval-gated" as const,
    pollIntervalMs: 300_000,
    lastPolledAt: "2026-09-17T00:00:00.000Z",
    lastResize: resize,
    history: [],
    status: "running" as const,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  return res.json();
}

/** Reads named SSE `event: ...\ndata: ...\n\n` frames off a live http.IncomingMessage. */
class SseReader {
  private buffer = "";
  private queue: Array<{ event: string; data: unknown }> = [];
  private waiters: Array<(v: { event: string; data: unknown }) => void> = [];

  constructor(res: http.IncomingMessage) {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (eventLine && dataLine) {
          const parsed = { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
          const waiter = this.waiters.shift();
          if (waiter) waiter(parsed);
          else this.queue.push(parsed);
        }
      }
    });
  }

  async next(): Promise<{ event: string; data: unknown }> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function connectSse(url: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage; reader: SseReader }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      resolve({ req, res, reader: new SseReader(res) });
    });
    req.on("error", reject);
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("runUi", () => {
  let tmpDir: string;
  let server: RunUiResult | undefined;
  let originalGoogleApiKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-ui-test-"));
    // Keep GCP pricing on its fixture path deterministically (see
    // e2e.test.ts's own use of this same guard) — only relevant to the
    // POST /api/plan tests below, harmless for the rest of this file.
    originalGoogleApiKey = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    await rm(tmpDir, { recursive: true, force: true });
    if (originalGoogleApiKey !== undefined) process.env["GOOGLE_API_KEY"] = originalGoogleApiKey;
  });

  describe("GET /api/plan", () => {
    it("returns { plan: null } when no plan.json exists", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const body = await fetchJson(`${server.url}/api/plan`);
      expect(body).toEqual({ plan: null });
    });

    it("returns the parsed plan once a valid plan.json is written", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const plan = samplePlan();
      await writeFile(path.join(tmpDir, "plan.json"), JSON.stringify(plan), "utf8");
      const body = (await fetchJson(`${server.url}/api/plan`)) as { plan: DeploymentPlan };
      expect(body.plan.requestId).toBe("plan-1");
      expect(body.plan.regions[0]?.geoId).toBe("eu-central");
    });

    it("returns an error shape for a malformed plan.json", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      await writeFile(path.join(tmpDir, "plan.json"), "{ not json", "utf8");
      const body = (await fetchJson(`${server.url}/api/plan`)) as { plan: null; error: string };
      expect(body.plan).toBeNull();
      expect(body.error).toContain("plan.json exists but failed to parse");
    });
  });

  describe("GET /api/apply", () => {
    it("returns { apply: null } when no apply.json exists", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const body = await fetchJson(`${server.url}/api/apply`);
      expect(body).toEqual({ apply: null });
    });

    it("returns the parsed apply record once a valid apply.json is written", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const record = sampleApply();
      await writeFile(path.join(tmpDir, "apply.json"), JSON.stringify(record), "utf8");
      const body = (await fetchJson(`${server.url}/api/apply`)) as { apply: ApplyRecord };
      expect(body.apply.requestId).toBe("plan-1");
      expect(body.apply.refused).toBe(true);
    });

    it("returns an error shape for a malformed apply.json", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      await writeFile(path.join(tmpDir, "apply.json"), JSON.stringify({ not: "valid" }), "utf8");
      const body = (await fetchJson(`${server.url}/api/apply`)) as { apply: null; error: string };
      expect(body.apply).toBeNull();
      expect(body.error).toContain("apply.json exists but failed to parse");
    });
  });

  describe("GET /api/monitor", () => {
    it("returns { monitor: null } when no monitor.json exists", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const body = await fetchJson(`${server.url}/api/monitor`);
      expect(body).toEqual({ monitor: null });
    });

    it("returns the parsed monitor record once a valid monitor.json is written", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      await writeFile(path.join(tmpDir, "monitor.json"), JSON.stringify(sampleMonitorRecord(false)), "utf8");
      const body = (await fetchJson(`${server.url}/api/monitor`)) as { monitor: { status: string } };
      expect(body.monitor.status).toBe("running");
    });

    it("returns an error shape for a malformed monitor.json", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      await writeFile(path.join(tmpDir, "monitor.json"), JSON.stringify({ not: "valid" }), "utf8");
      const body = (await fetchJson(`${server.url}/api/monitor`)) as { monitor: null; error: string };
      expect(body.monitor).toBeNull();
      expect(body.error).toContain("monitor.json exists but failed to parse");
    });
  });

  describe("POST /api/monitor/mode", () => {
    async function postMode(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it("writes the control file the geodeploy monitor process reads on its next poll", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { status, body } = await postMode(`${server.url}/api/monitor/mode`, { mode: "autonomous" });
      expect(status).toBe(200);
      expect(body).toEqual({ mode: "autonomous" });

      const control = JSON.parse(await readFile(path.join(tmpDir, "monitor-control.json"), "utf8"));
      expect(control).toEqual({ mode: "autonomous" });
    });

    it("rejects an invalid mode with a clear 400", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { status, body } = await postMode(`${server.url}/api/monitor/mode`, { mode: "full-send" });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/mode/);
    });
  });

  describe("POST /api/resize/apply", () => {
    async function writeResizeFixtures(applied: boolean): Promise<void> {
      await writeFile(path.join(tmpDir, "plan.json"), JSON.stringify(samplePlan()), "utf8");
      await writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          "eu-central": { workloadManifestFiles: [], ingress: { selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] } },
        }),
        "utf8",
      );
      await writeFile(path.join(tmpDir, "monitor.json"), JSON.stringify(sampleMonitorRecord(applied)), "utf8");
    }

    it("applies the pending resize, overwriting plan.json and marking it applied in monitor.json", async () => {
      await writeResizeFixtures(false);
      server = await runUi({ dir: tmpDir, port: 0 });

      const res = await fetch(`${server.url}/api/resize/apply`, { method: "POST" });
      const body = (await res.json()) as { refused: boolean };
      expect(res.status).toBe(200);
      expect(body.refused).toBe(true); // no real credentials in this test environment

      const planOnDisk = JSON.parse(await readFile(path.join(tmpDir, "plan.json"), "utf8")) as DeploymentPlan;
      expect(planOnDisk.regions.find((r) => r.geoId === "eu-central")?.nodesNeeded).toBe(3);

      const monitorOnDisk = JSON.parse(await readFile(path.join(tmpDir, "monitor.json"), "utf8")) as {
        lastResize: { applied: boolean };
      };
      expect(monitorOnDisk.lastResize.applied).toBe(true);
    });

    it("responds 400 with a clear error when the resize was already applied", async () => {
      await writeResizeFixtures(true);
      server = await runUi({ dir: tmpDir, port: 0 });

      const res = await fetch(`${server.url}/api/resize/apply`, { method: "POST" });
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/already applied/);
    });

    it("responds 400 with a clear error when there's no monitor.json at all", async () => {
      await writeFile(path.join(tmpDir, "plan.json"), JSON.stringify(samplePlan()), "utf8");
      server = await runUi({ dir: tmpDir, port: 0 });

      const res = await fetch(`${server.url}/api/resize/apply`, { method: "POST" });
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/ENOENT|no such file/);
    });
  });

  describe("GET /api/events (SSE)", () => {
    it("sends the initial missing snapshot, then pushes a live update on plan.json write", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { req, reader } = await connectSse(`${server.url}/api/events`);
      try {
        const first = await reader.next();
        const second = await reader.next();
        const third = await reader.next();
        const initial = [first, second, third];
        expect(initial.map((f) => f.event).sort()).toEqual(["apply-missing", "monitor-missing", "plan-missing"]);
        for (const frame of initial) {
          if (frame.event === "plan-missing") expect(frame.data).toEqual({ plan: null });
          if (frame.event === "apply-missing") expect(frame.data).toEqual({ apply: null });
          if (frame.event === "monitor-missing") expect(frame.data).toEqual({ monitor: null });
        }

        // No new connection — proves the push comes from fs.watch, not a
        // fresh on-connect snapshot.
        const plan = samplePlan();
        await writeFile(path.join(tmpDir, "plan.json"), JSON.stringify(plan), "utf8");

        const pushed = await reader.next();
        expect(pushed.event).toBe("plan");
        expect((pushed.data as { plan: DeploymentPlan }).plan.requestId).toBe("plan-1");
        expect((pushed.data as { plan: DeploymentPlan }).plan.regions[0]?.geoId).toBe("eu-central");
      } finally {
        req.destroy();
      }
    }, 10_000);
  });

  describe("GET /api/known-geos", () => {
    it("returns the known geo ids from @geodeploy/geo", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const body = (await fetchJson(`${server.url}/api/known-geos`)) as { geoIds: string[] };
      expect(body.geoIds).toContain("eu-central");
      expect(body.geoIds).toContain("us-east");
    });
  });

  describe("POST /api/apply", () => {
    it("responds 400 with a clear error when there's no plan.json at all", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const res = await fetch(`${server.url}/api/apply`, { method: "POST" });
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/no plan\.json found/);
    });

    it("responds inline (never 202) with a readiness refusal when no real credentials exist, writing apply.json", async () => {
      // Same real, unfaked checkApplyReadiness path applied at
      // /api/resize/apply above — this test environment has no real cloud
      // credentials, so this always exercises the fast refusal branch, never
      // the backgrounded "started: true" path (that path needs real
      // credentials to reach `provisionPlan` at all, exactly as `geodeploy
      // apply` itself does — see provisionPlan's own test suite for the
      // backgrounded progress-streaming behavior with injected stacks).
      await writeFile(path.join(tmpDir, "plan.json"), JSON.stringify(samplePlan()), "utf8");
      server = await runUi({ dir: tmpDir, port: 0 });

      const res = await fetch(`${server.url}/api/apply`, { method: "POST" });
      const body = (await res.json()) as { refused: boolean; blockers: string[] };
      expect(res.status).toBe(200);
      expect(body.refused).toBe(true);
      expect(body.blockers.length).toBeGreaterThan(0);

      const applyOnDisk = JSON.parse(await readFile(path.join(tmpDir, "apply.json"), "utf8")) as ApplyRecord;
      expect(applyOnDisk.refused).toBe(true);
    });
  });

  describe("GET /api/apply/progress", () => {
    it("reports not-in-progress when nothing is running", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const body = (await fetchJson(`${server.url}/api/apply/progress`)) as { inProgress: boolean };
      expect(body).toEqual({ inProgress: false });
    });
  });

  describe("POST /api/plan (the wizard endpoint)", () => {
    async function postPlan(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it("runs the real pipeline against fixture data and writes plan.json — the same file the SSE watcher already watches", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64", "linux/arm64"] },
        targetGeoIds: ["eu-central", "us-east"],
      });

      expect(status).toBe(200);
      const plan = (body as { plan: DeploymentPlan }).plan;
      expect(plan.regions.map((r) => r.geoId).sort()).toEqual(["eu-central", "us-east"]);

      // Written to disk — no separate persistence step needed for the SSE path to pick it up.
      const onDisk = JSON.parse(await readFile(path.join(tmpDir, "plan.json"), "utf8"));
      expect(onDisk.requestId).toBe(plan.requestId);
    });

    it("also writes config.json, applying the same manifests/ingress to every region — previously a hand-authored-only file", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64", "linux/arm64"] },
        targetGeoIds: ["eu-central", "us-east"],
        workload: { manifests: ["k8s/custom-deployment.yaml"] },
        ingress: { selector: { app: "my-app" }, ports: [{ port: 443, targetPort: 8443 }] },
      });
      expect(status).toBe(200);
      const plan = (body as { plan: DeploymentPlan }).plan;

      const configOnDisk = JSON.parse(await readFile(path.join(tmpDir, "config.json"), "utf8")) as Record<
        string,
        { workloadManifestFiles: string[]; ingress: unknown }
      >;
      expect(Object.keys(configOnDisk).sort()).toEqual(plan.regions.map((r) => r.geoId).sort());
      for (const geoId of Object.keys(configOnDisk)) {
        expect(configOnDisk[geoId]!.workloadManifestFiles).toEqual(["k8s/custom-deployment.yaml"]);
        expect(configOnDisk[geoId]!.ingress).toEqual({ selector: { app: "my-app" }, ports: [{ port: 443, targetPort: 8443 }] });
      }
    });

    it("falls back to DEFAULT_INGRESS in config.json when the wizard request omits ingress", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["eu-central"],
      });

      const configOnDisk = JSON.parse(await readFile(path.join(tmpDir, "config.json"), "utf8")) as Record<
        string,
        { ingress: unknown }
      >;
      expect(configOnDisk["eu-central"]!.ingress).toEqual({ selector: { app: "demo" }, ports: [{ port: 80, targetPort: 80 }] });
    });

    it("rejects a malformed ingress field with a clear 400, never touching the pipeline", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["eu-central"],
        ingress: { selector: "not-an-object", ports: [] },
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/body must be/);
    });

    it("wires the supplied DNS input into every region's config.json, with routingKey only for AWS regions", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["eu-central", "us-east"],
        dns: { recordName: "api.example.com", route53ZoneId: "Z0123456789ABCDEFGHIJ" },
      });
      expect(status).toBe(200);
      const plan = (body as { plan: DeploymentPlan }).plan;

      const configOnDisk = JSON.parse(await readFile(path.join(tmpDir, "config.json"), "utf8")) as Record<
        string,
        { dns?: { recordName: string; routingPolicy: string; routingKey?: string; route53: { zoneId: string } } }
      >;
      for (const region of plan.regions) {
        const dns = configOnDisk[region.geoId]!.dns!;
        expect(dns.recordName).toBe("api.example.com");
        expect(dns.routingPolicy).toBe("latency");
        expect(dns.route53).toEqual({ zoneId: "Z0123456789ABCDEFGHIJ" });
        if (region.provider === "aws") expect(dns.routingKey).toBe(region.region);
        else expect(dns.routingKey).toBeUndefined();
      }
    });

    it("omits dns from config.json entirely when the wizard request has none", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["eu-central"],
      });

      const configOnDisk = JSON.parse(await readFile(path.join(tmpDir, "config.json"), "utf8")) as Record<
        string,
        { dns?: unknown }
      >;
      expect(configOnDisk["eu-central"]!.dns).toBeUndefined();
    });

    it("rejects a malformed dns field with a clear 400, never touching the pipeline", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["eu-central"],
        dns: { recordName: "api.example.com" }, // missing route53ZoneId
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/body must be/);
    });

    it("rejects an unknown target geo id with a clear 400, never touching the pipeline", async () => {
      server = await runUi({ dir: tmpDir, port: 0, pricingOpts: fixturePricingOptions() });

      const { status, body } = await postPlan(`${server.url}/api/plan`, {
        image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
        targetGeoIds: ["not-a-real-geo"],
      });

      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/Unknown geo id "not-a-real-geo"/);
    });

    it("rejects a malformed body with a clear 400", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { status, body } = await postPlan(`${server.url}/api/plan`, { nonsense: true });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/body must be/);
    });
  });

  describe("POST /api/build-context", () => {
    function b64(text: string): string {
      return Buffer.from(text, "utf8").toString("base64");
    }

    async function postBuildContext(
      url: string,
      files: Array<{ path: string; contentBase64: string }>,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      return { status: res.status, body: await res.json() };
    }

    it("writes the uploaded folder to disk and returns the shallowest Dockerfile's path", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });

      const { status, body } = await postBuildContext(`${server.url}/api/build-context`, [
        { path: "app/Dockerfile", contentBase64: b64("FROM node:20\n") },
        { path: "app/src/index.js", contentBase64: b64("console.log('hi')\n") },
      ]);

      expect(status).toBe(200);
      const result = body as { buildContextId: string; dockerfilePath: string; fileCount: number; totalBytes: number };
      expect(result.dockerfilePath).toBe("app/Dockerfile");
      expect(result.fileCount).toBe(2);
      expect(result.totalBytes).toBe(Buffer.byteLength("FROM node:20\n") + Buffer.byteLength("console.log('hi')\n"));

      const dockerfileOnDisk = await readFile(
        path.join(tmpDir, "build-context", result.buildContextId, "app", "Dockerfile"),
        "utf8",
      );
      expect(dockerfileOnDisk).toBe("FROM node:20\n");
      const sourceOnDisk = await readFile(
        path.join(tmpDir, "build-context", result.buildContextId, "app", "src", "index.js"),
        "utf8",
      );
      expect(sourceOnDisk).toBe("console.log('hi')\n");
    });

    it("picks the shallowest Dockerfile when multiple are present", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { body } = await postBuildContext(`${server.url}/api/build-context`, [
        { path: "nested/deep/Dockerfile", contentBase64: b64("FROM alpine\n") },
        { path: "Dockerfile", contentBase64: b64("FROM node:20\n") },
      ]);
      expect((body as { dockerfilePath: string }).dockerfilePath).toBe("Dockerfile");
    });

    it("rejects a path-traversal attempt with a 400, writing nothing", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { status, body } = await postBuildContext(`${server.url}/api/build-context`, [
        { path: "Dockerfile", contentBase64: b64("FROM node:20\n") },
        { path: "../../evil.txt", contentBase64: b64("pwned") },
      ]);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/unsafe path/);

      const buildContextRoot = path.join(tmpDir, "build-context");
      const exists = await stat(buildContextRoot).then(
        () => true,
        () => false,
      );
      // Nothing should have been written at all -- the traversal check runs
      // before any file touches disk -- so build-context/ shouldn't even exist.
      expect(exists).toBe(false);
    });

    it("rejects an upload with no Dockerfile anywhere", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const { status, body } = await postBuildContext(`${server.url}/api/build-context`, [
        { path: "README.md", contentBase64: b64("hello") },
      ]);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/no Dockerfile/);
    });

    it("rejects an upload with more files than the configured limit", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const files = Array.from({ length: 2001 }, (_, i) => ({ path: `file-${i}.txt`, contentBase64: b64("x") }));
      const { status, body } = await postBuildContext(`${server.url}/api/build-context`, files);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/too many files/);
    });

    it("rejects an upload exceeding the total size limit", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const oversized = Buffer.alloc(50 * 1024 * 1024 + 1024, 0).toString("base64");
      const { status, body } = await postBuildContext(`${server.url}/api/build-context`, [
        { path: "Dockerfile", contentBase64: b64("FROM node:20\n") },
        { path: "big.bin", contentBase64: oversized },
      ]);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/exceeds/);
    }, 15_000);
  });

  describe("GET /api/build-context/:id", () => {
    it("lists a previously uploaded context's files", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const uploadRes = await fetch(`${server.url}/api/build-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [
            { path: "Dockerfile", contentBase64: Buffer.from("FROM node:20\n").toString("base64") },
            { path: "src/index.js", contentBase64: Buffer.from("x").toString("base64") },
          ],
        }),
      });
      const { buildContextId } = (await uploadRes.json()) as { buildContextId: string };

      const listRes = await fetch(`${server.url}/api/build-context/${buildContextId}`);
      expect(listRes.status).toBe(200);
      const { files } = (await listRes.json()) as { files: string[] };
      expect(files.sort()).toEqual(["Dockerfile", "src/index.js"]);
    });

    it("returns 404 for an unknown build context id", async () => {
      server = await runUi({ dir: tmpDir, port: 0 });
      const res = await fetch(`${server.url}/api/build-context/not-a-real-id`);
      expect(res.status).toBe(404);
    });
  });

  describe("close()", () => {
    it("actually releases the port", async () => {
      const port = await getFreePort();
      server = await runUi({ dir: tmpDir, port });
      await server.close();
      server = undefined;

      // If the port were still bound, a second listen on the exact same
      // port would fail with EADDRINUSE.
      const again = await runUi({ dir: tmpDir, port });
      expect(again.url).toContain(String(port));
      await again.close();
    });
  });

  describe("static file serving", () => {
    // These use `staticDir` (test-only override) to point at a temp
    // directory that either does or doesn't exist, rather than depending on
    // whether the real @geodeploy/web package has actually been built in
    // this checkout — its build is happening concurrently in this repo, so
    // asserting against it directly would be flaky by construction.

    it("serves a 503 with a clear message when the web dist/ directory is missing", async () => {
      const missingStaticDir = path.join(tmpDir, "web-dist-does-not-exist");
      server = await runUi({ dir: tmpDir, port: 0, staticDir: missingStaticDir });
      const res = await fetch(`${server.url}/`);
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(text).toContain("@geodeploy/web has not been built yet");
      expect(text).toContain("pnpm --filter @geodeploy/web build");
    });

    it("still serves /api/* routes normally when the frontend build is missing", async () => {
      const missingStaticDir = path.join(tmpDir, "web-dist-does-not-exist");
      server = await runUi({ dir: tmpDir, port: 0, staticDir: missingStaticDir });
      const res = await fetch(`${server.url}/api/plan`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ plan: null });
    });

    it("serves index.html for / and falls back to it for unknown SPA paths once a dist/ exists", async () => {
      const fakeDistDir = path.join(tmpDir, "web-dist-present");
      await mkdir(fakeDistDir, { recursive: true });
      await writeFile(path.join(fakeDistDir, "index.html"), "<html>geodeploy ui</html>", "utf8");
      await mkdir(path.join(fakeDistDir, "assets"), { recursive: true });
      await writeFile(path.join(fakeDistDir, "assets", "app.js"), "console.log('hi')", "utf8");

      server = await runUi({ dir: tmpDir, port: 0, staticDir: fakeDistDir });

      const root = await fetch(`${server.url}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("geodeploy ui");

      const asset = await fetch(`${server.url}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");

      const fallback = await fetch(`${server.url}/some/client/route`);
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toContain("geodeploy ui");
    });
  });
});
