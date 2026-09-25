import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideResize } from "./resize-engine.js";
import { makeDeploymentPlan, makeRegionPlan, makeRegionUtilization, makeUtilizationSnapshot } from "./test-helpers.js";

// This suite asserts the DEFAULT, live-executing behavior in this
// environment: no TYPESAFE_API_KEY exists, so every decision must go
// through the deterministic fallback path, end to end. No network access is
// ever attempted here (no vi.mock of @typesafe-ai/sdk at all — if the real
// TypeSafeClient were ever constructed with no API key, the SDK would throw
// on construction, which would fail these tests).

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env["TYPESAFE_API_KEY"];
  delete process.env["TYPESAFE_API_KEY"];
});

afterEach(() => {
  if (savedApiKey !== undefined) process.env["TYPESAFE_API_KEY"] = savedApiKey;
});

describe("decideResize (no TYPESAFE_API_KEY)", () => {
  it("degrades to deterministicResizeActions and never proposes a shift", async () => {
    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-hot", nodesNeeded: 4 }),
      makeRegionPlan({ geoId: "geo-cold", nodesNeeded: 4 }),
      makeRegionPlan({ geoId: "geo-steady", nodesNeeded: 4 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-hot", cpuUtilPct: 0.9 }),
      makeRegionUtilization({ geoId: "geo-cold", cpuUtilPct: 0.05 }),
      makeRegionUtilization({ geoId: "geo-steady", cpuUtilPct: 0.5 }),
    ]);

    const result = await decideResize({ plan, utilization });

    expect(result.actions).toEqual([
      { geoId: "geo-hot", action: "scale-up", newNodesNeeded: 6 },
      { geoId: "geo-cold", action: "scale-down", newNodesNeeded: 2 },
      { geoId: "geo-steady", action: "no-change" },
    ]);
    expect(result.actions.every((a) => a.action !== "shift-out" && a.action !== "shift-in")).toBe(true);

    expect(result.updatedRegions.find((r) => r.geoId === "geo-hot")?.nodesNeeded).toBe(6);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-cold")?.nodesNeeded).toBe(2);
    expect(result.updatedRegions.find((r) => r.geoId === "geo-steady")?.nodesNeeded).toBe(4);

    expect(result.confidencePassed).toBe(false);
    expect(result.decisionRecords).toHaveLength(1);
    expect(result.decisionRecords[0]?.mode).toBe("deterministic-fallback");
    expect(result.decisionRecords[0]?.kind).toBe("resize");
    expect(result.decisionRecords[0]?.reason).toMatch(/No TYPESAFE_API_KEY/);
    expect(result.decisionRecords[0]?.answers).toBeUndefined(); // no live attempt was ever made
  });

  it("reports no changes proposed when every region is within the thresholds", async () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.5 })]);

    const result = await decideResize({ plan, utilization });

    expect(result.actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
    expect(result.reason).toMatch(/no changes proposed/);
    expect(result.updatedRegions).toEqual(plan.regions);
  });

  it("throws a clear error when the plan has no regions", async () => {
    const plan = makeDeploymentPlan([]);
    const utilization = makeUtilizationSnapshot([]);

    await expect(decideResize({ plan, utilization })).rejects.toThrow(/no regions to resize/);
  });
});
