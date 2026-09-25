import { RegionCandidateSchema } from "@geodeploy/core";
import { describe, expect, it } from "vitest";
import { allCandidates, awsCandidates, azureCandidates, gcpCandidates } from "./index.js";

describe("schema validation", () => {
  it("every AWS candidate parses against RegionCandidateSchema", () => {
    for (const candidate of awsCandidates()) {
      expect(() => RegionCandidateSchema.parse(candidate)).not.toThrow();
    }
  });

  it("every Azure candidate parses against RegionCandidateSchema", () => {
    for (const candidate of azureCandidates()) {
      expect(() => RegionCandidateSchema.parse(candidate)).not.toThrow();
    }
  });

  it("every GCP candidate parses against RegionCandidateSchema", () => {
    for (const candidate of gcpCandidates()) {
      expect(() => RegionCandidateSchema.parse(candidate)).not.toThrow();
    }
  });
});

describe("snapshots", () => {
  it("aws region list is pinned", () => {
    expect(awsCandidates()).toMatchSnapshot();
  });

  it("azure region list is pinned", () => {
    expect(azureCandidates()).toMatchSnapshot();
  });

  it("gcp region list is pinned", () => {
    expect(gcpCandidates()).toMatchSnapshot();
  });
});

describe("allCandidates", () => {
  const candidates = allCandidates();

  it("includes at least 8 regions per provider", () => {
    expect(awsCandidates().length).toBeGreaterThanOrEqual(8);
    expect(azureCandidates().length).toBeGreaterThanOrEqual(8);
    expect(gcpCandidates().length).toBeGreaterThanOrEqual(8);
  });

  it("returns entries from all three providers", () => {
    const providers = new Set(candidates.map((c) => c.provider));
    expect(providers).toEqual(new Set(["aws", "azure", "gcp"]));
  });

  it("combined length equals the sum of the per-provider lists", () => {
    expect(candidates.length).toBe(
      awsCandidates().length + azureCandidates().length + gcpCandidates().length,
    );
  });

  it("has no placeholder {lat:0, lon:0} centroids and only plausible coordinates", () => {
    for (const c of candidates) {
      expect(c.centroid.lat === 0 && c.centroid.lon === 0).toBe(false);
      expect(c.centroid.lat).toBeGreaterThanOrEqual(-90);
      expect(c.centroid.lat).toBeLessThanOrEqual(90);
      expect(c.centroid.lon).toBeGreaterThanOrEqual(-180);
      expect(c.centroid.lon).toBeLessThanOrEqual(180);
    }
  });

  it("spans multiple continents (rough longitude/latitude spread check)", () => {
    const lats = candidates.map((c) => c.centroid.lat);
    const lons = candidates.map((c) => c.centroid.lon);
    // North America + APAC + Africa/Middle East present -> wide spread expected.
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(60);
    expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(150);
  });

  it("uses the correct managed k8s service string per provider", () => {
    for (const c of awsCandidates()) expect(c.managedK8sService).toBe("eks");
    for (const c of azureCandidates()) expect(c.managedK8sService).toBe("aks");
    for (const c of gcpCandidates()) expect(c.managedK8sService).toBe("gke");
  });

  it("has no duplicate (provider, region) pairs", () => {
    const keys = candidates.map((c) => `${c.provider}/${c.region}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
