import { describe, expect, it } from "vitest";
import { endpointFor, isApplyStale, pointColor, pointStatus } from "./pointColor";
import { theme } from "./theme";
import type { ApplyRecord, RegionPlan } from "./types";

function region(overrides: Partial<RegionPlan> = {}): RegionPlan {
  return {
    geoId: "us-east",
    provider: "aws",
    region: "us-east-1",
    sku: "t3.medium",
    centroid: { lat: 0, lon: 0 },
    demandCentroid: { lat: 0, lon: 0 },
    nodesNeeded: 2,
    monthlyUsd: 100,
    provisionable: true,
    modules: {
      cluster: "cluster.aws.eks",
      registry: "registry.aws.ecr",
      ingress: "ingress.public-alb",
      autoscaling: "autoscaling.none",
      sizing: "sizing.default",
    },
    ...overrides,
  };
}

function applyRecord(overrides: Partial<ApplyRecord> = {}): ApplyRecord {
  return {
    requestId: "plan-A",
    checkedAt: "2026-01-01T00:00:00.000Z",
    refused: false,
    blockers: [],
    ...overrides,
  };
}

describe("isApplyStale", () => {
  it("is false when there is no apply record at all", () => {
    expect(isApplyStale(null, "plan-A")).toBe(false);
  });

  it("is false when the apply record's requestId matches the current plan", () => {
    expect(isApplyStale(applyRecord({ requestId: "plan-A" }), "plan-A")).toBe(false);
  });

  it("is true when the apply record belongs to a different (superseded) plan revision", () => {
    expect(isApplyStale(applyRecord({ requestId: "plan-OLD" }), "plan-A")).toBe(true);
  });
});

describe("pointColor / pointStatus / endpointFor", () => {
  const succeeded = applyRecord({
    requestId: "plan-A",
    results: { "us-east": { status: "succeeded", outputs: { externalEndpoint: "1.2.3.4" } } },
  });

  it("reports succeeded/color/endpoint when the apply record matches the current plan", () => {
    expect(pointStatus(region(), succeeded, "plan-A")).toBe("succeeded");
    expect(pointColor(region(), succeeded, "plan-A")).toBe(theme.color.successBadge);
    expect(endpointFor(region(), succeeded, "plan-A")).toBe("1.2.3.4");
  });

  it("treats a matching-geoId apply record from a DIFFERENT plan revision as not-applied, not succeeded", () => {
    // Same geoId, same "succeeded" result -- but for an older plan.json that
    // has since been superseded by a new wizard submission (a real scenario:
    // two different plan revisions can both happen to include "us-east").
    expect(pointStatus(region(), succeeded, "plan-B")).toBe("not-applied");
    expect(pointColor(region(), succeeded, "plan-B")).toBe(theme.color.notAppliedPin);
    expect(endpointFor(region(), succeeded, "plan-B")).toBeNull();
  });

  it("still reports failed status for a current, matching-plan apply record", () => {
    const failed = applyRecord({ requestId: "plan-A", results: { "us-east": { status: "failed" } } });
    expect(pointStatus(region(), failed, "plan-A")).toBe("failed");
    expect(pointColor(region(), failed, "plan-A")).toBe(theme.color.failureBadge);
  });

  it("treats a refused apply the same regardless of requestId match", () => {
    const refused = applyRecord({ requestId: "plan-A", refused: true });
    expect(pointStatus(region(), refused, "plan-A")).toBe("not-applied");
  });
});
