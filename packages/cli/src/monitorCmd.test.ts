import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposeConfig } from "@geodeploy/compose";
import { DeploymentPlanSchema, MonitorRecordSchema, type DeploymentPlan } from "@geodeploy/core";
import type { RegionMetricsClient } from "@geodeploy/observe";
import { applyPendingResize, runMonitor, writeMonitorModeControl } from "./monitorCmd.js";

// Two-region fixture plan (not the uiCmd.test.ts single-region one — the
// resize/rebalance path needs at least two regions to exercise shift-eligible
// scenarios in future tests, and this file's assertions are clearer with two
// distinguishable geos throughout).
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
      {
        geoId: "us-east",
        provider: "aws",
        region: "us-east-1",
        sku: "t3.medium",
        centroid: { lat: 39.0438, lon: -77.4874 },
        demandCentroid: { lat: 40.7128, lon: -74.006 },
        nodesNeeded: 2,
        monthlyUsd: 150,
        provisionable: false,
        modules: {
          cluster: "cluster.aws.eks",
          registry: "registry.aws.ecr",
          ingress: "ingress.k8s.service-lb",
          autoscaling: "autoscaling.cluster-autoscaler-conservative",
          sizing: "sizing.xs",
        },
      },
    ],
    dns: { provider: null, reason: "no dns backend usable" },
    totalMonthlyUsd: 350,
    decisionRecords: [],
    allowedProviders: ["aws", "azure", "gcp"],
    detectedProviders: [],
    notes: [],
  };
}

function sampleConfigByGeo(): Record<string, ComposeConfig> {
  const config: ComposeConfig = {
    workloadManifestFiles: [],
    ingress: { selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] },
  };
  return { "eu-central": config, "us-east": config };
}

/** A `RegionMetricsClient` fake that reports a fixed core count, no network/cluster involved. */
function fakeMetricsClientFor(cpuUsedCores: number, podCount = 3) {
  return async (): Promise<RegionMetricsClient> => ({
    queryUtilization: async () => ({ observedAt: "2026-09-17T00:00:00.000Z", cpuUsedCores, podCount }),
  });
}

const FAKE_STACK_OUTPUTS = async () => ({ kubeconfig: { value: "apiVersion: v1\nkind: Config\n", secret: true } });

describe("runMonitor", () => {
  let tmpDir: string;
  let originalApiKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-monitor-"));
    originalApiKey = process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"]; // force the deterministic resize fallback path throughout
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalApiKey !== undefined) process.env["TYPESAFE_API_KEY"] = originalApiKey;
  });

  async function writeFixturePlan(): Promise<{ planPath: string; configPath: string }> {
    const planPath = path.join(tmpDir, "plan.json");
    const configPath = path.join(tmpDir, "config.json");
    await writeFile(planPath, JSON.stringify(samplePlan(), null, 2), "utf8");
    await writeFile(configPath, JSON.stringify(sampleConfigByGeo(), null, 2), "utf8");
    return { planPath, configPath };
  }

  it("approval-gated mode: writes a not-yet-applied ResizePlan proposing scale-up for an over-utilized region", async () => {
    const { planPath, configPath } = await writeFixturePlan();

    // eu-central: 2 nodes * 2 vcpu = 4 allocatable cores; 3.6 used -> 90% util (> 0.80 threshold -> scale-up).
    // us-east: 2 nodes * 2 vcpu = 4 allocatable cores; 0.4 used -> 10% util (< 0.30 threshold -> scale-down).
    let call = 0;
    const { monitorJsonPath, done, stop } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      mode: "approval-gated",
      maxIterations: 1,
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: (regionPlan) => {
          call += 1;
          return regionPlan.geoId === "eu-central" ? fakeMetricsClientFor(3.6)() : fakeMetricsClientFor(0.4)();
        },
      },
    });
    stop();
    await done;
    expect(call).toBe(2);

    const monitorRaw = JSON.parse(await readFile(monitorJsonPath, "utf8"));
    const monitor = MonitorRecordSchema.parse(monitorRaw);

    expect(monitor.status).toBe("running");
    expect(monitor.lastResize).toBeDefined();
    expect(monitor.lastResize!.applied).toBe(false);
    expect(monitor.lastResize!.mode).toBe("approval-gated");

    const actionByGeo = new Map(monitor.lastResize!.actions.map((a) => [a.geoId, a]));
    expect(actionByGeo.get("eu-central")).toMatchObject({ action: "scale-up", newNodesNeeded: 3 });
    expect(actionByGeo.get("us-east")).toMatchObject({ action: "scale-down", newNodesNeeded: 1 });

    // plan.json on disk is untouched in approval-gated mode.
    const planOnDisk = DeploymentPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    expect(planOnDisk.regions.find((r) => r.geoId === "eu-central")!.nodesNeeded).toBe(2);
  });

  it("approval-gated mode: no-change utilization produces an all-no-change ResizePlan", async () => {
    const { planPath, configPath } = await writeFixturePlan();

    const { monitorJsonPath, done } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      maxIterations: 1,
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: fakeMetricsClientFor(2), // 2/4 = 50% util, between both thresholds
      },
    });
    await done;

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    expect(monitor.lastResize!.actions.every((a) => a.action === "no-change")).toBe(true);
    expect(monitor.lastResize!.applied).toBe(false);
  });

  it("autonomous mode: applies an eligible deterministic-fallback resize by overwriting plan.json and calling runApply", async () => {
    const { planPath, configPath } = await writeFixturePlan();

    const { monitorJsonPath, done } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      mode: "autonomous",
      maxIterations: 1,
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: (regionPlan) =>
          regionPlan.geoId === "eu-central" ? fakeMetricsClientFor(3.6)() : fakeMetricsClientFor(2)(),
      },
    });
    await done;

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    // Deterministic fallback resizes are always auto-apply eligible (see
    // monitorCmd.ts's isEligibleForAutoApply) since they're safe-by-construction.
    expect(monitor.lastResize!.applied).toBe(true);

    const planOnDisk = DeploymentPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    expect(planOnDisk.regions.find((r) => r.geoId === "eu-central")!.nodesNeeded).toBe(3);
    expect(planOnDisk.regions.find((r) => r.geoId === "us-east")!.nodesNeeded).toBe(2); // unchanged (50% util)

    // No real credentials in this environment -> runApply refuses cleanly,
    // but the refusal itself is still a real, recorded apply attempt.
    const applyRaw = JSON.parse(await readFile(path.join(tmpDir, "apply.json"), "utf8"));
    expect(applyRaw.refused).toBe(true);
  });

  it("autonomous mode: never applies when every action is no-change", async () => {
    const { planPath, configPath } = await writeFixturePlan();

    const { monitorJsonPath, done } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      mode: "autonomous",
      maxIterations: 1,
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: fakeMetricsClientFor(2),
      },
    });
    await done;

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    expect(monitor.lastResize!.applied).toBe(false);

    const planOnDisk = DeploymentPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    expect(planOnDisk.regions.find((r) => r.geoId === "eu-central")!.nodesNeeded).toBe(2);
  });

  it("rejects outright (no monitor.json at all) when the config file doesn't exist at startup", async () => {
    const planPath = path.join(tmpDir, "plan.json");
    await writeFile(planPath, JSON.stringify(samplePlan(), null, 2), "utf8");
    const configPath = path.join(tmpDir, "does-not-exist.json");

    // Missing plan/config is a startup failure, not a transient per-poll
    // condition — it happens before the polling loop (and its own
    // status:"error" monitor.json write, exercised via the next test) ever
    // starts, so runMonitor itself rejects.
    await expect(runMonitor({ planPath, configPath, outDir: tmpDir, maxIterations: 1 })).rejects.toThrow(/ENOENT/);
  });

  it("records status: error (without throwing) when a single poll fails, e.g. decideResize rejecting a regionless plan", async () => {
    const planPath = path.join(tmpDir, "plan.json");
    const configPath = path.join(tmpDir, "config.json");
    await writeFile(planPath, JSON.stringify({ ...samplePlan(), regions: [] }, null, 2), "utf8");
    await writeFile(configPath, JSON.stringify({}, null, 2), "utf8");

    const { monitorJsonPath, done } = await runMonitor({ planPath, configPath, outDir: tmpDir, maxIterations: 1 });
    await done;

    // decideResize throws outright for a plan with no regions (nothing to
    // resize) -- unlike collectUtilization's per-region isolation, this is a
    // genuine whole-poll failure, and pollOnce's own try/catch turns it into
    // a recorded status:"error" rather than rejecting runMonitor itself
    // (which would tear down the whole long-running loop over one bad poll).
    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    expect(monitor.status).toBe("error");
    expect(monitor.error).toMatch(/no regions/);
  });

  it("stop() ends the loop before maxIterations, without needing the real interval to elapse", async () => {
    const { planPath, configPath } = await writeFixturePlan();
    let polls = 0;
    // `sleep` needs to call `stop`, but `stop` is only returned once
    // `runMonitor` resolves — that resolution happens synchronously right
    // after the loop's background IIFE starts, well before the first
    // `sleep()` call (which only happens after the first `pollOnce()`'s real
    // file/async work completes), so this ref is populated in time.
    let stopRef: (() => void) | undefined;

    const { done, stop } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      intervalMs: 60_000,
      sleep: async () => {
        polls += 1;
        // Stop mid-loop instead of actually waiting a minute between polls.
        stopRef?.();
      },
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: fakeMetricsClientFor(2),
      },
    });
    stopRef = stop;
    await done;

    expect(polls).toBe(1);
  });

  it("re-reads config.json fresh every poll, picking up edits made after the process started", async () => {
    const planPath = path.join(tmpDir, "plan.json");
    const configPath = path.join(tmpDir, "config.json");
    await writeFile(planPath, JSON.stringify(samplePlan(), null, 2), "utf8");
    // Regression test: config.json used to be read once at process startup
    // and never again, so an edit made after the process was already
    // running (e.g. via a later POST to add a region) was silently ignored
    // for the rest of the process's life -- surfacing as a permanent
    // "no ComposeConfig supplied" error even after the file on disk was
    // fixed. Starts with only one of the two regions configured...
    const fullConfig = sampleConfigByGeo();
    await writeFile(configPath, JSON.stringify({ "eu-central": fullConfig["eu-central"] }, null, 2), "utf8");

    const { monitorJsonPath, done } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      maxIterations: 2,
      // ...and the missing region's config is added between polls, without
      // restarting the monitor process.
      sleep: async () => {
        await writeFile(configPath, JSON.stringify(fullConfig, null, 2), "utf8");
      },
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: fakeMetricsClientFor(2),
      },
    });
    await done;

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    const usEastUtil = monitor.lastResize!.utilization.regions.find((r) => r.geoId === "us-east");
    expect(usEastUtil?.error).toBeUndefined();
  });

  it("a live mode-control file overrides the startup mode on the next poll, without restarting", async () => {
    const { planPath, configPath } = await writeFixturePlan();

    const { monitorJsonPath, done } = await runMonitor({
      planPath,
      configPath,
      outDir: tmpDir,
      mode: "approval-gated",
      maxIterations: 2,
      // Simulates a POST /api/monitor/mode call landing between polls (see
      // uiCmd.ts's handler, which just calls writeMonitorModeControl).
      sleep: async () => {
        await writeMonitorModeControl(tmpDir, "autonomous");
      },
      vcpuPerNodeForSku: async () => 2,
      collectUtilizationOverrides: {
        getStackOutputsFor: FAKE_STACK_OUTPUTS,
        metricsClientFor: (regionPlan) =>
          regionPlan.geoId === "eu-central" ? fakeMetricsClientFor(3.6)() : fakeMetricsClientFor(2)(),
      },
    });
    await done;

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(monitorJsonPath, "utf8")));
    expect(monitor.mode).toBe("autonomous");
    // Deterministic-fallback scale-up is always auto-apply eligible, so the
    // second poll (now running with mode=autonomous) actually applies it.
    expect(monitor.lastResize!.applied).toBe(true);
  });
});

describe("applyPendingResize", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-apply-resize-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFixtures(): Promise<{ planPath: string; configPath: string }> {
    const planPath = path.join(tmpDir, "plan.json");
    const configPath = path.join(tmpDir, "config.json");
    await writeFile(planPath, JSON.stringify(samplePlan(), null, 2), "utf8");
    await writeFile(configPath, JSON.stringify(sampleConfigByGeo(), null, 2), "utf8");
    return { planPath, configPath };
  }

  async function writeMonitorWithPendingResize(applied: boolean): Promise<void> {
    const plan = samplePlan();
    const updatedRegions = plan.regions.map((r) => (r.geoId === "eu-central" ? { ...r, nodesNeeded: 3 } : r));
    const monitor = {
      requestId: plan.requestId,
      mode: "approval-gated" as const,
      pollIntervalMs: 300_000,
      lastPolledAt: "2026-09-17T00:00:00.000Z",
      lastResize: {
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
      },
      history: [],
      status: "running" as const,
    };
    await writeFile(path.join(tmpDir, "monitor.json"), JSON.stringify(MonitorRecordSchema.parse(monitor), null, 2), "utf8");
  }

  it("overwrites plan.json with the pending resize's updatedRegions, calls runApply, and marks it applied", async () => {
    const { planPath, configPath } = await writeFixtures();
    await writeMonitorWithPendingResize(false);

    const result = await applyPendingResize({ planPath, monitorDir: tmpDir, configPath });
    expect(result.refused).toBe(true); // no real credentials in this test environment

    const planOnDisk = DeploymentPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    expect(planOnDisk.regions.find((r) => r.geoId === "eu-central")!.nodesNeeded).toBe(3);

    const monitor = MonitorRecordSchema.parse(JSON.parse(await readFile(path.join(tmpDir, "monitor.json"), "utf8")));
    expect(monitor.lastResize!.applied).toBe(true);
  });

  it("refuses to re-apply a resize that's already marked applied", async () => {
    const { planPath, configPath } = await writeFixtures();
    await writeMonitorWithPendingResize(true);

    await expect(applyPendingResize({ planPath, monitorDir: tmpDir, configPath })).rejects.toThrow(/already applied/);
  });

  it("throws a clear error when monitor.json has no lastResize at all", async () => {
    const { planPath, configPath } = await writeFixtures();
    await writeFile(
      path.join(tmpDir, "monitor.json"),
      JSON.stringify(
        MonitorRecordSchema.parse({
          requestId: "plan-1",
          mode: "approval-gated",
          pollIntervalMs: 300_000,
          history: [],
          status: "running",
        }),
        null,
        2,
      ),
      "utf8",
    );

    await expect(applyPendingResize({ planPath, monitorDir: tmpDir, configPath })).rejects.toThrow(/no resize recorded/);
  });
});
