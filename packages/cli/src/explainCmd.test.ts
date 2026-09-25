import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeploymentPlan } from "@geodeploy/core";
import { formatExplain, runExplain } from "./explainCmd.js";

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
    notes: ["No configured providers detected; full comparison shown."],
  };
}

describe("formatExplain", () => {
  it("includes per-geo mode, selection, and reason", () => {
    const text = formatExplain(samplePlan());
    expect(text).toContain("GEO eu-central:");
    expect(text).toContain("deterministic-fallback");
    expect(text).toContain("azure:westeurope");
    expect(text).toContain("Deterministic fallback: chose azure:westeurope");
  });

  it("includes composite score and gate pass/fail when present", () => {
    const plan = samplePlan();
    plan.decisionRecords.push({
      geoId: "eu-central",
      kind: "geo-selection",
      mode: "typesafe",
      selection: { provider: "azure", region: "westeurope" },
      gates: { regionSelection: { value: 0.92, threshold: 0.9, passed: true } },
      composite: 0.77,
      reason: "Stage A pick.",
    });
    const text = formatExplain(plan);
    expect(text).toContain("0.770");
    expect(text).toContain("PASS");
  });
});

describe("runExplain", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-explain-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads and re-validates a plan.json file", async () => {
    const planPath = path.join(tmpDir, "plan.json");
    await writeFile(planPath, JSON.stringify(samplePlan()), "utf8");

    const { plan, text } = await runExplain({ planPath });
    expect(plan.requestId).toBe("plan-1");
    expect(text).toContain("GEO eu-central:");
  });

  it("rejects a schema-invalid plan.json", async () => {
    const planPath = path.join(tmpDir, "bad-plan.json");
    await writeFile(planPath, JSON.stringify({ not: "a plan" }), "utf8");

    await expect(runExplain({ planPath })).rejects.toThrow();
  });
});
