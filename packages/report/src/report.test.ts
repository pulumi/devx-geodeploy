import { describe, expect, it } from "vitest";
import type { CandidateCost, DeploymentPlan } from "@geodeploy/core";
import { DeploymentPlanSchema } from "@geodeploy/core";
import { renderPlanJson } from "./planJson.js";
import { renderPlanMarkdown } from "./planMarkdown.js";
import { renderPriceTable } from "./priceTable.js";

function samplePlan(): DeploymentPlan {
  const plan = {
    requestId: "plan-2026-09-16T00:00:00.000Z",
    createdAt: "2026-09-16T00:00:00.000Z",
    regions: [
      {
        geoId: "eu-central",
        provider: "aws",
        region: "eu-central-1",
        sku: "m6g.large",
        centroid: { lat: 50.1109, lon: 8.6821 },
        demandCentroid: { lat: 50.1109, lon: 8.6821 },
        nodesNeeded: 3,
        monthlyUsd: 421.5,
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
    dns: { provider: null, reason: "No DNS backend has usable credentials. Checked in preference order: route53 (not detected); ns1 (not detected); cloudflare (not detected)." },
    totalMonthlyUsd: 421.5,
    decisionRecords: [
      {
        geoId: "eu-central",
        mode: "deterministic-fallback",
        selection: { provider: "aws", region: "eu-central-1" },
        reason:
          "No TYPESAFE_API_KEY configured in the environment. Deterministic fallback: chose aws:eu-central-1 at $421.50/mo — cheapest of 6 candidate(s) passing allowedProviders/residency(eu-only)/capacity(GA) checks; runner-up was azure:westeurope at $455.00/mo.",
      },
    ],
    allowedProviders: ["aws", "azure", "gcp"],
    detectedProviders: [],
    notes: ["No configured providers detected; full comparison shown — supply credentials to enable provisioning."],
  };
  return DeploymentPlanSchema.parse(plan);
}

function sampleCandidates(): CandidateCost[] {
  return [
    {
      provider: "aws",
      region: "eu-central-1",
      sku: "m6g.large",
      arch: "arm64",
      centroid: { lat: 50.1109, lon: 8.6821 },
      nodesNeeded: 3,
      monthlyUsd: 421.5,
      breakdown: { computeUsd: 300, controlPlaneUsd: 73, egressUsd: 10, storageUsd: 8, lbUsd: 30.5 },
      distanceKm: 12,
      azCount: 3,
      gaStatus: true,
      complianceFlags: ["gdpr"],
      realism: "live",
      provisionable: false,
    },
    {
      provider: "azure",
      region: "westeurope",
      sku: "Standard_D2s_v5",
      arch: "x86_64",
      centroid: { lat: 52.3676, lon: 4.9041 },
      nodesNeeded: 3,
      monthlyUsd: 455.0,
      breakdown: { computeUsd: 330, controlPlaneUsd: 73, egressUsd: 10, storageUsd: 8, lbUsd: 34 },
      distanceKm: 610,
      azCount: 3,
      gaStatus: true,
      complianceFlags: ["gdpr"],
      realism: "fixture",
      provisionable: false,
    },
  ];
}

describe("renderPlanJson", () => {
  it("produces valid, re-parseable JSON matching the schema", () => {
    const plan = samplePlan();
    const json = renderPlanJson(plan);
    const parsed = DeploymentPlanSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(plan);
  });

  it("is pretty-printed (indented, multi-line)", () => {
    const json = renderPlanJson(samplePlan());
    expect(json.split("\n").length).toBeGreaterThan(5);
    expect(json).toContain('  "requestId"');
  });
});

describe("renderPlanMarkdown", () => {
  it("puts notes prominently near the top", () => {
    const md = renderPlanMarkdown(samplePlan());
    const notesIdx = md.indexOf("No configured providers detected");
    const regionsIdx = md.indexOf("## Regions");
    expect(notesIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeLessThan(regionsIdx);
  });

  it("includes a per-geo region table row", () => {
    const md = renderPlanMarkdown(samplePlan());
    expect(md).toContain("| eu-central | aws | eu-central-1 | m6g.large | 3 | $421.50 | no |");
  });

  it("surfaces the decision reason, including the runner-up and why it lost", () => {
    const md = renderPlanMarkdown(samplePlan());
    expect(md).toContain("runner-up was azure:westeurope at $455.00/mo");
    expect(md).toContain("deterministic-fallback");
  });

  it("surfaces composite score and gate pass/fail for typesafe-mode records", () => {
    const plan = samplePlan();
    plan.decisionRecords.push({
      geoId: "eu-central",
      kind: "geo-selection",
      mode: "typesafe",
      selection: { provider: "aws", region: "eu-central-1" },
      gates: { regionSelection: { value: 0.97, threshold: 0.9, passed: true } },
      composite: 0.845,
      reason: "Stage A selected aws:eu-central-1 with confidence 0.97.",
    });
    const md = renderPlanMarkdown(plan);
    expect(md).toContain("0.845");
    expect(md).toContain("PASS");
    expect(md).toContain("regionSelection");
  });

  it("renders the DNS backend decision and reason", () => {
    const md = renderPlanMarkdown(samplePlan());
    expect(md).toContain("## DNS");
    expect(md).toContain("none selected");
    expect(md).toContain("No DNS backend has usable credentials");
  });

  it("renders the total monthly cost", () => {
    const md = renderPlanMarkdown(samplePlan());
    expect(md).toContain("$421.50/month");
  });
});

describe("renderPriceTable", () => {
  it("renders a ranked table with a live/fixture realism tag per row", () => {
    const table = renderPriceTable(sampleCandidates());
    expect(table).toContain("aws");
    expect(table).toContain("m6g.large");
    expect(table).toContain("421.50");
    expect(table).toContain("live");
    expect(table).toContain("azure");
    expect(table).toContain("fixture");
  });

  it("handles an empty candidate list without throwing", () => {
    expect(renderPriceTable([])).toContain("No priced candidates");
  });
});
