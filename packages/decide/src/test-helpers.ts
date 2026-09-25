import type {
  CandidateCost,
  Constraints,
  DeploymentPlan,
  RegionPlan,
  RegionUtilization,
  TargetGeo,
  UtilizationSnapshot,
} from "@geodeploy/core";

/** Shared test fixtures. Not a *.test.ts file, so vitest never treats it as a suite. */
export function makeCandidate(overrides: Partial<CandidateCost> = {}): CandidateCost {
  return {
    provider: "aws",
    region: "us-east-1",
    sku: "m5.large",
    arch: "x86_64",
    centroid: { lat: 39.0438, lon: -77.4874 },
    nodesNeeded: 3,
    monthlyUsd: 300,
    breakdown: { computeUsd: 200, controlPlaneUsd: 50, egressUsd: 20, storageUsd: 20, lbUsd: 10 },
    distanceKm: 500,
    azCount: 3,
    gaStatus: true,
    complianceFlags: [],
    realism: "fixture",
    provisionable: false,
    ...overrides,
  };
}

export function makeGeo(overrides: Partial<TargetGeo> = {}): TargetGeo {
  return {
    id: "eu-west-demand",
    centroid: { lat: 48.8566, lon: 2.3522 },
    weightPct: 100,
    ...overrides,
  };
}

export function makeConstraints(overrides: Partial<Constraints> = {}): Constraints {
  return {
    maxProviders: 2,
    ...overrides,
  };
}

export function makeRegionPlan(overrides: Partial<RegionPlan> = {}): RegionPlan {
  return {
    geoId: "geo-1",
    provider: "aws",
    region: "us-east-1",
    sku: "m5.large",
    centroid: { lat: 39.0438, lon: -77.4874 },
    demandCentroid: { lat: 40.7128, lon: -74.006 },
    nodesNeeded: 4,
    monthlyUsd: 300,
    provisionable: true,
    modules: {
      cluster: "cluster.aws.eks",
      registry: "registry.aws.ecr",
      ingress: "ingress.public-alb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.s",
    },
    ...overrides,
  };
}

export function makeRegionUtilization(overrides: Partial<RegionUtilization> = {}): RegionUtilization {
  return {
    geoId: "geo-1",
    observedAt: "2026-01-01T00:00:00.000Z",
    cpuUsedCores: 2,
    cpuAllocatableCores: 4,
    cpuUtilPct: 0.5,
    nodeCount: 4,
    podCount: 8,
    ...overrides,
  };
}

export function makeUtilizationSnapshot(
  regions: RegionUtilization[] = [makeRegionUtilization()],
  overrides: Partial<Omit<UtilizationSnapshot, "regions">> = {},
): UtilizationSnapshot {
  return {
    requestId: "utilization-1",
    collectedAt: "2026-01-01T00:00:00.000Z",
    regions,
    ...overrides,
  };
}

/** A minimal, schema-valid DeploymentPlan for resize tests, which only care about `regions`. */
export function makeDeploymentPlan(
  regions: RegionPlan[] = [makeRegionPlan()],
  overrides: Partial<Omit<DeploymentPlan, "regions">> = {},
): DeploymentPlan {
  return {
    requestId: "plan-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    regions,
    dns: { provider: null, reason: "no DNS backend configured for this fixture" },
    totalMonthlyUsd: regions.reduce((sum, r) => sum + r.monthlyUsd, 0),
    decisionRecords: [],
    allowedProviders: ["aws", "azure", "gcp"],
    detectedProviders: [],
    notes: [],
    ...overrides,
  };
}
