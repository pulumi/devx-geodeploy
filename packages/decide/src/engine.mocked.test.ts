import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so these are initialized before the vi.mock factory below runs
// (vi.mock calls are hoisted to the top of the file by vitest).
const mocks = vi.hoisted(() => ({
  stageAAnswers: vi.fn(),
  stageBAnswers: vi.fn(),
  capturedRequests: [] as Array<{ state: unknown; questions: Record<string, unknown> }>,
}));

// The real question builders (choice/score/noul) are passed through
// unmodified via importOriginal — only TypeSafeClient.systemOne is faked, so
// this exercises the real request-building logic in questions.ts and only
// stubs out the network call itself. The real SDK is never actually invoked.
vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  class FakeTypeSafeClient {
    async systemOne(request: { state: unknown; questions: Record<string, unknown> }) {
      mocks.capturedRequests.push(request);
      const answers = "selection" in request.questions ? mocks.stageAAnswers() : mocks.stageBAnswers();
      return { model: "jev-mock", usage: { input_tokens: 10, output_tokens: 10 }, answers };
    }
  }
  return { ...actual, TypeSafeClient: FakeTypeSafeClient };
});

import type { DeploymentRequest } from "@geodeploy/core";
import { buildDeploymentPlan, decideGeo } from "./engine.js";
import { composite, resolveWeights } from "./composite.js";
import { makeCandidate, makeGeo } from "./test-helpers.js";

function stageA(overrides: Record<string, unknown> = {}) {
  return {
    selection: {
      type: "choice",
      choice: "aws:us-east-1",
      confidence: 0.95,
      probabilities: { "aws:us-east-1": 0.95, "azure:eastus": 0.03, "gcp:us-central1": 0.02 },
    },
    coverage: { type: "score", score: 8, confidence: 0.9, legend: {}, probabilities: {} },
    costFit: { type: "score", score: 7, confidence: 0.9, legend: {}, probabilities: {} },
    maturity: { type: "score", score: 8, confidence: 0.9, legend: {}, probabilities: {} },
    sprawlRisk: { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: {} },
    archConsistency: { type: "score", score: 9, confidence: 0.9, legend: {}, probabilities: {} },
    residencyOk: { type: "noul", noul: 0.97 },
    capacityOk: { type: "noul", noul: 0.96 },
    fallback: {
      type: "choice",
      choice: "azure:eastus",
      confidence: 0.8,
      probabilities: { "aws:us-east-1": 0.1, "azure:eastus": 0.8, "gcp:us-central1": 0.1 },
    },
    ...overrides,
  };
}

function stageB(overrides: Record<string, unknown> = {}) {
  return {
    ingress: { type: "choice", choice: "ingress.public-alb", confidence: 0.9, probabilities: {} },
    autoscaling: { type: "choice", choice: "autoscaling.karpenter-bin-packing", confidence: 0.9, probabilities: {} },
    sizing: { type: "choice", choice: "sizing.m", confidence: 0.7, probabilities: {} },
    ...overrides,
  };
}

const candidates = [
  makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 250, nodesNeeded: 4 }),
  makeCandidate({ provider: "azure", region: "eastus", monthlyUsd: 220, nodesNeeded: 3 }),
  makeCandidate({ provider: "gcp", region: "us-central1", monthlyUsd: 300, nodesNeeded: 5 }),
];

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env["TYPESAFE_API_KEY"];
  process.env["TYPESAFE_API_KEY"] = "test-key-not-real";
  mocks.stageAAnswers.mockReset();
  mocks.stageBAnswers.mockReset();
  mocks.capturedRequests.length = 0;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env["TYPESAFE_API_KEY"];
  else process.env["TYPESAFE_API_KEY"] = savedApiKey;
});

describe("decideGeo — mocked TypeSafe SDK, live path", () => {
  it("parses Stage A + Stage B answers, applies gates, and computes the composite score in code", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA());
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("us-east-1");
    expect(result.decisionRecords).toHaveLength(2);
    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
    expect(result.decisionRecords[1]?.mode).toBe("typesafe");

    const expectedComposite = composite(
      { costFit: 7, coverage: 8, maturity: 8, sprawlRisk: 2, archConsistency: 9 },
      resolveWeights("latency-optimized"),
    );
    expect(result.decisionRecords[0]?.composite).toBeCloseTo(expectedComposite, 10);

    expect(result.decisionRecords[0]?.gates?.["residencyOk"]).toEqual({ value: 0.97, threshold: 0.95, passed: true });
    expect(result.decisionRecords[0]?.gates?.["regionSelection"]).toEqual({ value: 0.95, threshold: 0.9, passed: true });

    // Stage B answers all clear their gates -> the model's own choices are used, not registry defaults.
    expect(result.moduleSelection).toEqual({
      cluster: "cluster.aws.eks",
      registry: "registry.aws.ecr",
      ingress: "ingress.public-alb",
      autoscaling: "autoscaling.karpenter-bin-packing",
      sizing: "sizing.m",
    });
  });

  it("hard-rejects the AI selection when residencyOk is below its 0.95 gate, even though the call succeeded", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA({ residencyOk: { type: "noul", noul: 0.8 } }));
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    // Falls all the way back to the deterministic path for this geo.
    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.reason).toMatch(/residencyOk hard gate failed/);
    // Deterministic path picks cheapest of the three (azure at 220), independent of what the model chose (aws).
    expect(result.provider).toBe("azure");
    expect(result.region).toBe("eastus");
  });

  it("does NOT fall back when a composite-scoring input (e.g. maturity) is low-confidence — only selection/residencyOk/capacityOk gate the AI path", async () => {
    // Confirmed live against a real TypeSafe org: coverage/costFit/maturity/
    // sprawlRisk/archConsistency legitimately land low-confidence for real
    // data reasons (e.g. a price sitting right on a rubric bin boundary)
    // that have nothing to do with whether the region `selection` itself is
    // sound — selection was independently 96-98% confident in that case, so
    // discarding it over a shaky *composite input* was overly conservative.
    // These five still feed `composite()` and land in the DecisionRecord for
    // audit; they just can't abort the AI path on their own anymore.
    const lowConfidenceMaturity = { type: "score", score: 8, confidence: 0.05, legend: {}, probabilities: {} };
    mocks.stageAAnswers.mockReturnValue(stageA({ maturity: lowConfidenceMaturity }));
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
    expect(result.decisionRecords[0]?.answers).toMatchObject({ maturity: lowConfidenceMaturity });
  });

  it("still falls back when the actual decision (selection) or a hard noul gate breaches the global floor", async () => {
    mocks.stageAAnswers.mockReturnValue(
      stageA({ selection: { type: "choice", choice: "aws:us-east-1", confidence: 0.3, probabilities: {} } }),
    );
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.reason).toMatch(/global floor breached on "selection"/);
    // The real API call did happen and returned a real (if rejected) answer
    // — it must be preserved for audit, not silently discarded. Confirmed
    // live: without this, a genuine low-confidence response vanished
    // entirely once it triggered a fallback.
    expect(result.decisionRecords[0]?.questions).toBeDefined();
    expect(result.decisionRecords[0]?.state).toBeDefined();
  });

  it("keeps Stage A's real, gate-passing decision record when only Stage B aborts", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA());
    mocks.stageBAnswers.mockReturnValue(
      stageB({ sizing: { type: "choice", choice: "sizing.m", confidence: 0.2, probabilities: {} } }),
    );

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    // Two records: Stage A's real success, then the fallback Stage B triggered.
    expect(result.decisionRecords).toHaveLength(2);
    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
    expect(result.decisionRecords[0]?.answers).toBeDefined();
    expect(result.decisionRecords[1]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[1]?.reason).toMatch(/global floor breached on Stage B "sizing"/);
    expect(result.decisionRecords[1]?.answers).toBeDefined();
  });

  it("keeps the model's top pick but flags human review when region-selection confidence is below the new-cluster gate", async () => {
    mocks.stageAAnswers.mockReturnValue(
      stageA({
        selection: {
          type: "choice",
          choice: "aws:us-east-1",
          confidence: 0.6,
          probabilities: { "aws:us-east-1": 0.6, "azure:eastus": 0.25, "gcp:us-central1": 0.15 },
        },
      }),
    );
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({
      geo: makeGeo(),
      candidates,
      constraints: { maxProviders: 2 },
      isIncumbent: false,
    });

    expect(result.provider).toBe("aws"); // still the model's own top pick
    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
    expect(result.notes[0]).toMatch(/top-3 candidates require explicit human pick/);
    expect(result.decisionRecords[0]?.gates?.["regionSelection"]?.passed).toBe(false);
  });

  it("keeps the incumbent region when region-selection confidence is below the incumbent gate", async () => {
    mocks.stageAAnswers.mockReturnValue(
      stageA({
        selection: {
          type: "choice",
          choice: "aws:us-east-1",
          confidence: 0.6,
          probabilities: { "aws:us-east-1": 0.6, "azure:eastus": 0.25, "gcp:us-central1": 0.15 },
        },
      }),
    );
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({
      geo: makeGeo(),
      candidates,
      constraints: { maxProviders: 2 },
      isIncumbent: true,
      incumbentRegion: { provider: "azure", region: "eastus" },
    });

    expect(result.provider).toBe("azure");
    expect(result.region).toBe("eastus");
    expect(result.notes[0]).toMatch(/keeping incumbent region/);
  });

  it("includes Docker/build facts (image platforms, already-committed architectures) in Stage A's state", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA());
    mocks.stageBAnswers.mockReturnValue(stageB());

    await decideGeo({
      geo: makeGeo(),
      candidates,
      constraints: { maxProviders: 2 },
      imagePlatforms: ["linux/amd64", "linux/arm64"],
      committedArches: new Set(["arm64"]),
    });

    const stageARequest = mocks.capturedRequests.find((r) => "selection" in r.questions);
    expect(stageARequest?.state).toMatchObject({
      image: {
        platforms: ["linux/amd64", "linux/arm64"],
        isMultiArch: true,
        architecturesAlreadyCommitted: ["arm64"],
      },
    });
  });

  it("reports the deployment's build as single-arch and nothing yet committed when neither is given", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA());
    mocks.stageBAnswers.mockReturnValue(stageB());

    await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    const stageARequest = mocks.capturedRequests.find((r) => "selection" in r.questions);
    expect(stageARequest?.state).toMatchObject({
      image: { platforms: [], isMultiArch: false, architecturesAlreadyCommitted: [] },
    });
  });

  it("does NOT fall back when archConsistency is low-confidence — it's a composite input, not the decision", async () => {
    mocks.stageAAnswers.mockReturnValue(
      stageA({ archConsistency: { type: "score", score: 3, confidence: 0.2, legend: {}, probabilities: {} } }),
    );
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
  });

  it("still hard-rejects on residencyOk/capacityOk breaching the global floor, even with a confident selection", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA({ capacityOk: { type: "noul", noul: 0.1 } }));
    mocks.stageBAnswers.mockReturnValue(stageB());

    const result = await decideGeo({ geo: makeGeo(), candidates, constraints: { maxProviders: 2 } });

    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.reason).toMatch(/global floor breached on "capacityOk"/);
  });
});

describe("buildDeploymentPlan — cross-geo architecture accumulation", () => {
  it("feeds each geo's already-committed architectures forward to the next geo's Stage A state", async () => {
    mocks.stageAAnswers.mockReturnValue(stageA());
    mocks.stageBAnswers.mockReturnValue(stageB());

    const request: DeploymentRequest = {
      targetGeos: [makeGeo({ id: "geo-1" }), makeGeo({ id: "geo-2" })],
      image: { reference: "example/app:1.0.0", platforms: ["linux/amd64", "linux/arm64"] },
      workload: {
        manifests: ["k8s/deployment.yaml"],
        replicasPerRegion: 3,
        requestsPerPod: { vcpu: 1, memGiB: 2 },
        egressGiBPerMonth: 10,
        storageGiB: 10,
      },
      constraints: { maxProviders: 2 },
    };

    await buildDeploymentPlan({
      request,
      candidatesByGeo: { "geo-1": candidates, "geo-2": candidates },
      providerReadiness: [],
      dnsReadiness: [],
    });

    // The mock always picks "aws:us-east-1" (arch x86_64, per makeCandidate's
    // default) regardless of which geo is asking — so geo-2's Stage A state
    // must show geo-1's committed x86_64, while geo-1's showed nothing yet.
    const stageARequests = mocks.capturedRequests.filter((r) => "selection" in r.questions);
    expect(stageARequests).toHaveLength(2);
    expect(stageARequests[0]?.state).toMatchObject({ image: { architecturesAlreadyCommitted: [] } });
    expect(stageARequests[1]?.state).toMatchObject({ image: { architecturesAlreadyCommitted: ["x86_64"] } });
  });
});
