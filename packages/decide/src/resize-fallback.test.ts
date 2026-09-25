import { describe, expect, it } from "vitest";
import {
  deterministicResizeActions,
  RESIZE_HIGH_UTIL_THRESHOLD,
  RESIZE_LOW_UTIL_THRESHOLD,
  scaledDownNodes,
  scaledUpNodes,
} from "./resize-fallback.js";
import { makeDeploymentPlan, makeRegionPlan, makeRegionUtilization, makeUtilizationSnapshot } from "./test-helpers.js";

describe("thresholds", () => {
  it("match the documented values", () => {
    expect(RESIZE_HIGH_UTIL_THRESHOLD).toBe(0.8);
    expect(RESIZE_LOW_UTIL_THRESHOLD).toBe(0.3);
  });
});

describe("scaledUpNodes / scaledDownNodes", () => {
  it("scales up by 1.5x, rounding up", () => {
    expect(scaledUpNodes(4)).toBe(6);
    expect(scaledUpNodes(3)).toBe(5); // ceil(4.5) = 5
  });

  it("scales down by 0.5x, rounding down, never below 1", () => {
    expect(scaledDownNodes(4)).toBe(2);
    expect(scaledDownNodes(3)).toBe(1); // floor(1.5) = 1
    expect(scaledDownNodes(1)).toBe(1); // floor(0.5) = 0, clamped to 1
    expect(scaledDownNodes(2)).toBe(1); // floor(1) = 1
  });
});

describe("deterministicResizeActions", () => {
  it("scales up a region strictly above the high-utilization threshold", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.81 })]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "scale-up", newNodesNeeded: 6 }]);
  });

  it("does NOT scale up exactly at the high-utilization threshold (boundary is exclusive)", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: RESIZE_HIGH_UTIL_THRESHOLD }),
    ]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
  });

  it("scales down a region strictly below the low-utilization threshold", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.1 })]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "scale-down", newNodesNeeded: 2 }]);
  });

  it("does NOT scale down exactly at the low-utilization threshold (boundary is exclusive)", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: RESIZE_LOW_UTIL_THRESHOLD }),
    ]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
  });

  it("leaves a region between the thresholds unchanged", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.5 })]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
  });

  it("resolves an errored region to no-change, never resizing blind", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.95, error: "metrics API query failed: timeout" }),
    ]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
  });

  it("resolves a region missing from the utilization snapshot entirely to no-change", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 })]);
    const utilization = makeUtilizationSnapshot([]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([{ geoId: "geo-1", action: "no-change" }]);
  });

  it("never proposes a shift-out/shift-in, even with multiple regions at opposite extremes", () => {
    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-hot", nodesNeeded: 4 }),
      makeRegionPlan({ geoId: "geo-cold", nodesNeeded: 4 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-hot", cpuUtilPct: 0.95 }),
      makeRegionUtilization({ geoId: "geo-cold", cpuUtilPct: 0.05 }),
    ]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions.map((a) => a.action)).toEqual(["scale-up", "scale-down"]);
    expect(actions.every((a) => a.action !== "shift-out" && a.action !== "shift-in")).toBe(true);
    expect(actions.every((a) => a.pairedGeoId === undefined)).toBe(true);
  });

  it("evaluates each region independently, one action per region", () => {
    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", nodesNeeded: 4 }),
      makeRegionPlan({ geoId: "geo-2", nodesNeeded: 10 }),
      makeRegionPlan({ geoId: "geo-3", nodesNeeded: 2 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.5 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.9 }),
      makeRegionUtilization({ geoId: "geo-3", cpuUtilPct: 0.2 }),
    ]);

    const actions = deterministicResizeActions(plan, utilization);

    expect(actions).toEqual([
      { geoId: "geo-1", action: "no-change" },
      { geoId: "geo-2", action: "scale-up", newNodesNeeded: 15 },
      { geoId: "geo-3", action: "scale-down", newNodesNeeded: 1 },
    ]);
  });
});
