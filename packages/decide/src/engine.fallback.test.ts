import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeploymentRequest } from "@geodeploy/core";
import { DeploymentPlanSchema } from "@geodeploy/core";
import { buildDeploymentPlan, decideGeo } from "./engine.js";
import { makeCandidate, makeGeo } from "./test-helpers.js";

// This suite asserts the DEFAULT, live-executing behavior in this
// environment: no TYPESAFE_API_KEY exists, so every decision must go through
// the deterministic fallback path, end to end, producing a fully valid
// DeploymentPlan. No network access is ever attempted here.

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env["TYPESAFE_API_KEY"];
  delete process.env["TYPESAFE_API_KEY"];
});

afterEach(() => {
  if (savedApiKey !== undefined) process.env["TYPESAFE_API_KEY"] = savedApiKey;
});

describe("decideGeo (no TYPESAFE_API_KEY)", () => {
  it("uses the deterministic fallback path and never calls the network", async () => {
    const candidates = [
      makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 250, sku: "m5.large", nodesNeeded: 4 }),
      makeCandidate({ provider: "azure", region: "eastus", monthlyUsd: 180, sku: "Standard_D4s_v5", nodesNeeded: 3 }),
      makeCandidate({ provider: "gcp", region: "us-central1", monthlyUsd: 300, sku: "n2-standard-4", nodesNeeded: 4 }),
    ];

    const result = await decideGeo({
      geo: makeGeo(),
      candidates,
      constraints: { maxProviders: 2 },
    });

    expect(result.provider).toBe("azure");
    expect(result.region).toBe("eastus");
    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.reason).toMatch(/No TYPESAFE_API_KEY/);
    expect(result.moduleSelection).toEqual({
      cluster: "cluster.azure.aks",
      registry: "registry.azure.acr",
      ingress: "ingress.public-alb",
      autoscaling: "autoscaling.cluster-autoscaler-conservative",
      sizing: "sizing.s",
    });
  });

  it("throws a clear error when no candidate can satisfy the hard constraints", async () => {
    const candidates = [makeCandidate({ complianceFlags: [] })];
    await expect(
      decideGeo({
        geo: makeGeo({ residency: "eu-only" }),
        candidates,
        constraints: { maxProviders: 2 },
      }),
    ).rejects.toThrow(/no candidate passes/i);
  });
});

describe("buildDeploymentPlan (no TYPESAFE_API_KEY) — full end-to-end fallback plan", () => {
  it("produces a complete, schema-valid DeploymentPlan with every decision record in fallback mode", async () => {
    const request: DeploymentRequest = {
      targetGeos: [
        { id: "na-east", centroid: { lat: 40.7128, lon: -74.006 }, weightPct: 60 },
        { id: "eu-west", centroid: { lat: 48.8566, lon: 2.3522 }, weightPct: 40, residency: "eu-only" },
      ],
      image: { reference: "example/app:1.0.0", platforms: ["linux/amd64"] },
      workload: {
        manifests: ["k8s/deployment.yaml"],
        replicasPerRegion: 3,
        requestsPerPod: { vcpu: 1, memGiB: 2 },
        egressGiBPerMonth: 100,
        storageGiB: 50,
      },
      constraints: { maxProviders: 2 },
    };

    const candidatesByGeo = {
      "na-east": [
        makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 220, complianceFlags: [] }),
        makeCandidate({ provider: "azure", region: "eastus", monthlyUsd: 260, complianceFlags: [] }),
        makeCandidate({ provider: "gcp", region: "us-east4", monthlyUsd: 210, complianceFlags: [] }),
      ],
      "eu-west": [
        makeCandidate({ provider: "aws", region: "eu-west-1", monthlyUsd: 240, complianceFlags: ["gdpr"] }),
        makeCandidate({ provider: "azure", region: "westeurope", monthlyUsd: 230, complianceFlags: ["gdpr"] }),
        // Not GDPR-flagged: must be rejected by the residency gate even though it's cheapest.
        makeCandidate({ provider: "gcp", region: "me-west1", monthlyUsd: 90, complianceFlags: [] }),
      ],
    };

    const plan = await buildDeploymentPlan({
      request,
      candidatesByGeo,
      providerReadiness: [], // nothing detected — today's real state
      dnsReadiness: [],
    });

    // Full schema round-trip: this throws if the plan isn't valid.
    expect(() => DeploymentPlanSchema.parse(plan)).not.toThrow();

    expect(plan.regions).toHaveLength(2);
    for (const region of plan.regions) {
      expect(region.provisionable).toBe(false);
    }
    expect(plan.decisionRecords).toHaveLength(2);
    for (const record of plan.decisionRecords) {
      expect(record.mode).toBe("deterministic-fallback");
    }

    const euRegion = plan.regions.find((r) => r.geoId === "eu-west");
    expect(euRegion?.provider).toBe("azure");
    expect(euRegion?.region).toBe("westeurope");

    const naRegion = plan.regions.find((r) => r.geoId === "na-east");
    expect(naRegion?.provider).toBe("gcp");
    expect(naRegion?.region).toBe("us-east4");

    expect(plan.dns.provider).toBeNull();
    expect(plan.dns.reason).toMatch(/no dns backend/i);

    expect(plan.detectedProviders).toEqual([]);
    expect(plan.notes.some((n) => /no configured providers detected/i.test(n))).toBe(true);
    expect(plan.allowedProviders.sort()).toEqual(["aws", "azure", "gcp"]);
    expect(plan.totalMonthlyUsd).toBeCloseTo(230 + 210, 5);
  });

  it("selects route53 when it is usable, per the default DNS preference order", async () => {
    const request: DeploymentRequest = {
      targetGeos: [{ id: "geo-1", centroid: { lat: 0, lon: 0 }, weightPct: 100 }],
      image: { reference: "example/app:1.0.0", platforms: ["linux/amd64"] },
      workload: {
        manifests: ["k8s/deployment.yaml"],
        replicasPerRegion: 1,
        requestsPerPod: { vcpu: 1, memGiB: 1 },
        egressGiBPerMonth: 10,
        storageGiB: 10,
      },
      constraints: { maxProviders: 2 },
    };

    const plan = await buildDeploymentPlan({
      request,
      candidatesByGeo: { "geo-1": [makeCandidate({ provider: "aws", region: "us-east-1" })] },
      providerReadiness: [{ provider: "aws", tier1: true, tier2: null, detail: "AWS_PROFILE set" }],
      dnsReadiness: [
        { provider: "cloudflare", tier1: true, tier2: null, detail: "CLOUDFLARE_API_TOKEN set" },
        { provider: "route53", tier1: true, tier2: null, detail: "AWS_PROFILE set" },
      ],
    });

    expect(plan.dns.provider).toBe("route53");
    expect(plan.regions[0]?.provisionable).toBe(true);
    expect(plan.detectedProviders).toEqual(["aws"]);
    expect(plan.allowedProviders).toEqual(["aws"]);
  });
});
