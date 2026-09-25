import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so this is initialized before the vi.mock factory below runs
// (vi.mock calls are hoisted to the top of the file by vitest).
const mocks = vi.hoisted(() => ({
  answers: vi.fn(),
  capturedRequests: [] as Array<{ state: unknown; questions: Record<string, unknown> }>,
}));

// The real question builders (choice/score/noul) are passed through
// unmodified via importOriginal — only TypeSafeClient.systemOne is faked, so
// this exercises the real request-building logic in resize-questions.ts and
// only stubs out the network call itself. The real SDK is never invoked.
// Same pattern as engine.mocked.test.ts.
vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  class FakeTypeSafeClient {
    async systemOne(request: { state: unknown; questions: Record<string, unknown> }) {
      mocks.capturedRequests.push(request);
      return { model: "jev-mock", usage: { input_tokens: 10, output_tokens: 10 }, answers: mocks.answers() };
    }
  }
  return { ...actual, TypeSafeClient: FakeTypeSafeClient };
});

import { decideResize } from "./resize-engine.js";
import { makeDeploymentPlan, makeRegionPlan, makeRegionUtilization, makeUtilizationSnapshot } from "./test-helpers.js";

function resizeAnswers(overrides: Record<string, unknown> = {}) {
  return {
    topology: {
      type: "choice",
      choice: "no-change",
      confidence: 0.9,
      probabilities: { "no-change": 0.9 },
    },
    confidence: { type: "score", score: 8, confidence: 0.85, legend: {}, probabilities: {} },
    riskOfDisruption: { type: "noul", noul: 0.9 },
    ...overrides,
  };
}

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env["TYPESAFE_API_KEY"];
  process.env["TYPESAFE_API_KEY"] = "test-key-not-real";
  mocks.answers.mockReset();
  mocks.capturedRequests.length = 0;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env["TYPESAFE_API_KEY"];
  else process.env["TYPESAFE_API_KEY"] = savedApiKey;
});

describe("decideResize — mocked TypeSafe SDK, live path", () => {
  it("no-change: leaves every region's plan untouched", async () => {
    mocks.answers.mockReturnValue(resizeAnswers({ topology: { type: "choice", choice: "no-change", confidence: 0.9, probabilities: {} } }));

    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4, sku: "m5.large" }),
      makeRegionPlan({ geoId: "geo-2", nodesNeeded: 3, sku: "m5.medium" }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.5 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.5 }),
    ]);

    const result = await decideResize({ plan, utilization });

    expect(result.actions).toEqual([
      { geoId: "geo-1", action: "no-change" },
      { geoId: "geo-2", action: "no-change" },
    ]);
    expect(result.updatedRegions).toEqual(plan.regions);
    expect(result.confidencePassed).toBe(true);
    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("typesafe");
    expect(result.decisionRecords[0]?.kind).toBe("resize");
    expect(result.decisionRecords[0]?.geoId).toBe("geo-1"); // first region, since nothing acted upon
  });

  it("scale-up: increases the chosen region's nodesNeeded by the deterministic multiplier", async () => {
    mocks.answers.mockReturnValue(
      resizeAnswers({ topology: { type: "choice", choice: "scale-up:geo-1", confidence: 0.95, probabilities: {} } }),
    );

    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4, sku: "m5.large" }),
      makeRegionPlan({ geoId: "geo-2", nodesNeeded: 3, sku: "m5.medium" }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.9 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.5 }),
    ]);

    const result = await decideResize({ plan, utilization });

    expect(result.actions).toEqual([
      { geoId: "geo-1", action: "scale-up", newNodesNeeded: 6 }, // ceil(4 * 1.5)
      { geoId: "geo-2", action: "no-change" },
    ]);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-1")?.nodesNeeded).toBe(6);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-1")?.sku).toBe("m5.large"); // sku untouched
    expect(result.updatedRegions.find((r) => r.geoId === "geo-2")?.nodesNeeded).toBe(3);
    expect(result.confidencePassed).toBe(true);
    expect(result.decisionRecords[0]?.geoId).toBe("geo-1");
    expect(result.decisionRecords[0]?.selection).toEqual({ provider: "aws", region: "us-east-1" });
    expect(result.decisionRecords[0]?.gates?.["topology"]?.passed).toBe(true);
  });

  it("scale-down: decreases the chosen region's nodesNeeded by the deterministic multiplier", async () => {
    mocks.answers.mockReturnValue(
      resizeAnswers({ topology: { type: "choice", choice: "scale-down:geo-2", confidence: 0.95, probabilities: {} } }),
    );

    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 }),
      makeRegionPlan({ geoId: "geo-2", nodesNeeded: 4 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.5 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.1 }),
    ]);

    const result = await decideResize({ plan, utilization });

    expect(result.actions).toEqual([
      { geoId: "geo-1", action: "no-change" },
      { geoId: "geo-2", action: "scale-down", newNodesNeeded: 2 }, // floor(4 * 0.5)
    ]);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-2")?.nodesNeeded).toBe(2);
  });

  it("shift: decomposes into a paired shift-out (source) / shift-in (destination)", async () => {
    mocks.answers.mockReturnValue(
      resizeAnswers({
        topology: { type: "choice", choice: "shift:geo-1->geo-2", confidence: 0.92, probabilities: {} },
      }),
    );

    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", nodesNeeded: 10 }),
      makeRegionPlan({ geoId: "geo-2", nodesNeeded: 4 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.85 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.4 }),
    ]);

    const result = await decideResize({ plan, utilization });

    // SHIFT_SOURCE_RETAIN_FRACTION = 0.7: source keeps floor(10*0.7)=7, moves 3 to destination.
    expect(result.actions).toEqual([
      { geoId: "geo-1", action: "shift-out", newNodesNeeded: 7, pairedGeoId: "geo-2" },
      { geoId: "geo-2", action: "shift-in", newNodesNeeded: 7, pairedGeoId: "geo-1" },
    ]);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-1")?.nodesNeeded).toBe(7);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-2")?.nodesNeeded).toBe(7);
    expect(result.confidencePassed).toBe(true);
    expect(result.decisionRecords[0]?.reason).toMatch(/shift:geo-1->geo-2/);
  });

  it("falls back to deterministic actions (but keeps mode=typesafe) when the topology gate fails but the global floor doesn't breach", async () => {
    mocks.answers.mockReturnValue(
      resizeAnswers({
        topology: { type: "choice", choice: "scale-up:geo-1", confidence: 0.6, probabilities: {} }, // >= 0.5 floor, < 0.7 suggest gate
      }),
    );

    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.9 })]);

    const result = await decideResize({ plan, utilization });

    // Deterministic fallback arithmetic used for the actual actions, not the model's specific pick.
    expect(result.actions).toEqual([{ geoId: "geo-1", action: "scale-up", newNodesNeeded: 6 }]);
    expect(result.confidencePassed).toBe(false);
    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("typesafe"); // the call itself succeeded
    expect(result.decisionRecords[0]?.gates?.["topology"]?.passed).toBe(false);
    expect(result.decisionRecords[0]?.reason).toMatch(/below the suggest threshold/);
  });

  it("falls back entirely (deterministic-fallback record) when the global floor is breached", async () => {
    mocks.answers.mockReturnValue(
      resizeAnswers({
        topology: { type: "choice", choice: "scale-up:geo-1", confidence: 0.3, probabilities: {} }, // < 0.5 floor
      }),
    );

    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.9 })]);

    const result = await decideResize({ plan, utilization });

    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.reason).toMatch(/global floor breached on "topology"/);
    expect(result.decisionRecords[0]?.answers).toBeDefined(); // real partial attempt preserved
    // Deterministic fallback still computes the right arithmetic answer.
    expect(result.actions).toEqual([{ geoId: "geo-1", action: "scale-up", newNodesNeeded: 6 }]);
    expect(result.confidencePassed).toBe(false);
  });
});
