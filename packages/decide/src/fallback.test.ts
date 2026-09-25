import { describe, expect, it } from "vitest";
import {
  capacitySatisfied,
  deterministicSizingTier,
  isUsRegion,
  REGISTRY_DEFAULT_AUTOSCALING,
  REGISTRY_DEFAULT_INGRESS,
  residencySatisfied,
  selectCheapestPassingGates,
} from "./fallback.js";
import { makeCandidate, makeGeo } from "./test-helpers.js";

describe("isUsRegion", () => {
  it("recognizes AWS/GCP-style us- prefixed regions", () => {
    expect(isUsRegion("us-east-1")).toBe(true);
    expect(isUsRegion("us-west-2")).toBe(true);
    expect(isUsRegion("us-central1")).toBe(true);
  });

  it("recognizes Azure-style us-suffixed regions", () => {
    expect(isUsRegion("eastus")).toBe(true);
    expect(isUsRegion("westus2")).toBe(true);
  });

  it("does not false-positive on unrelated regions containing 'us' as a substring", () => {
    expect(isUsRegion("australiaeast")).toBe(false);
    expect(isUsRegion("australia-southeast1")).toBe(false);
  });

  it("rejects clearly non-US regions", () => {
    expect(isUsRegion("westeurope")).toBe(false);
    expect(isUsRegion("canadacentral")).toBe(false);
    expect(isUsRegion("southeastasia")).toBe(false);
  });
});

describe("residencySatisfied", () => {
  const gdprCandidate = makeCandidate({ region: "westeurope", complianceFlags: ["gdpr"] });
  const plainCandidate = makeCandidate({ region: "eastus", complianceFlags: [] });
  const inCountryCandidate = makeCandidate({ region: "southafricanorth", complianceFlags: ["in-country-only"] });
  const usCandidate = makeCandidate({ region: "us-east-1", complianceFlags: [] });

  it("is always satisfied when residency is unset or 'none'", () => {
    expect(residencySatisfied(undefined, plainCandidate)).toBe(true);
    expect(residencySatisfied("none", plainCandidate)).toBe(true);
  });

  it("'eu-only' requires the gdpr compliance flag", () => {
    expect(residencySatisfied("eu-only", gdprCandidate)).toBe(true);
    expect(residencySatisfied("eu-only", plainCandidate)).toBe(false);
  });

  it("'in-country' requires the in-country-only compliance flag", () => {
    expect(residencySatisfied("in-country", inCountryCandidate)).toBe(true);
    expect(residencySatisfied("in-country", plainCandidate)).toBe(false);
  });

  it("'us-only' requires a recognized US region", () => {
    expect(residencySatisfied("us-only", usCandidate)).toBe(true);
    expect(residencySatisfied("us-only", gdprCandidate)).toBe(false);
  });
});

describe("capacitySatisfied", () => {
  it("mirrors the region's GA status", () => {
    expect(capacitySatisfied({ gaStatus: true })).toBe(true);
    expect(capacitySatisfied({ gaStatus: false })).toBe(false);
  });
});

describe("deterministicSizingTier", () => {
  it("buckets nodesNeeded into the documented tiers", () => {
    expect(deterministicSizingTier(1)).toBe("sizing.xs");
    expect(deterministicSizingTier(2)).toBe("sizing.xs");
    expect(deterministicSizingTier(3)).toBe("sizing.s");
    expect(deterministicSizingTier(5)).toBe("sizing.s");
    expect(deterministicSizingTier(6)).toBe("sizing.m");
    expect(deterministicSizingTier(10)).toBe("sizing.m");
    expect(deterministicSizingTier(11)).toBe("sizing.l");
    expect(deterministicSizingTier(20)).toBe("sizing.l");
    expect(deterministicSizingTier(21)).toBe("sizing.xl");
    expect(deterministicSizingTier(500)).toBe("sizing.xl");
  });
});

describe("selectCheapestPassingGates", () => {
  it("picks the cheapest candidate among those passing residency+capacity", () => {
    const cheap = makeCandidate({ provider: "gcp", region: "us-central1", monthlyUsd: 100, gaStatus: true });
    const mid = makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 200, gaStatus: true });
    const expensive = makeCandidate({ provider: "azure", region: "eastus", monthlyUsd: 300, gaStatus: true });

    const result = selectCheapestPassingGates([mid, expensive, cheap], makeGeo(), {});

    expect(result.chosen).not.toBeNull();
    expect(result.chosen?.provider).toBe("gcp");
    expect(result.chosen?.monthlyUsd).toBe(100);
    expect(result.reason).toMatch(/cheapest/i);
  });

  it("rejects candidates failing the capacity (GA) gate even if cheaper", () => {
    const cheapButNotGa = makeCandidate({ provider: "gcp", region: "us-central1", monthlyUsd: 50, gaStatus: false });
    const validCandidate = makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 200, gaStatus: true });

    const result = selectCheapestPassingGates([cheapButNotGa, validCandidate], makeGeo(), {});

    expect(result.chosen?.provider).toBe("aws");
  });

  it("rejects candidates failing the residency gate", () => {
    const nonGdpr = makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 50, complianceFlags: [] });
    const gdpr = makeCandidate({ provider: "azure", region: "westeurope", monthlyUsd: 400, complianceFlags: ["gdpr"] });

    const result = selectCheapestPassingGates(
      [nonGdpr, gdpr],
      makeGeo({ residency: "eu-only" }),
      {},
    );

    expect(result.chosen?.provider).toBe("azure");
    expect(result.chosen?.region).toBe("westeurope");
  });

  it("respects an allowedProviders constraint", () => {
    const aws = makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 10 });
    const gcp = makeCandidate({ provider: "gcp", region: "us-central1", monthlyUsd: 1000 });

    const result = selectCheapestPassingGates([aws, gcp], makeGeo(), {
      allowedProviders: ["gcp"],
    });

    expect(result.chosen?.provider).toBe("gcp");
  });

  it("returns null with a clear reason when no candidate passes every hard constraint", () => {
    const nonGdpr = makeCandidate({ provider: "aws", region: "us-east-1", complianceFlags: [] });
    const result = selectCheapestPassingGates([nonGdpr], makeGeo({ residency: "eu-only" }), {});

    expect(result.chosen).toBeNull();
    expect(result.reason).toMatch(/no candidate passes/i);
  });

  it("keeps the residency/capacity-passing pool (over budget, noted) rather than returning null when nothing fits the budget", () => {
    const onlyOption = makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 500, gaStatus: true });
    const result = selectCheapestPassingGates([onlyOption], makeGeo(), { maxMonthlyUsd: 100 });

    expect(result.chosen?.provider).toBe("aws");
    expect(result.reason).toMatch(/exceeds maxMonthlyUsd/i);
  });
});

describe("registry defaults", () => {
  it("are stable ids consumable by the module registry", () => {
    expect(REGISTRY_DEFAULT_INGRESS).toBe("ingress.public-alb");
    expect(REGISTRY_DEFAULT_AUTOSCALING).toBe("autoscaling.cluster-autoscaler-conservative");
  });
});
