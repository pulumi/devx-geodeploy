import { describe, expect, it } from "vitest";
import { applyGate, breachesGlobalFloor, GATE_THRESHOLDS, regionSelectionThreshold } from "./gates.js";

describe("GATE_THRESHOLDS", () => {
  it("matches PROJECT-PLAN.md §5.5's gates table exactly", () => {
    expect(GATE_THRESHOLDS.residencyOk).toBe(0.95);
    expect(GATE_THRESHOLDS.newClusterRegionSelection).toBe(0.9);
    expect(GATE_THRESHOLDS.incumbentRegionSelection).toBe(0.75);
    expect(GATE_THRESHOLDS.moduleSelection).toBe(0.85);
    expect(GATE_THRESHOLDS.resizeTopologySuggest).toBe(0.7);
    expect(GATE_THRESHOLDS.resizeTopologyAutoApply).toBe(0.85);
    expect(GATE_THRESHOLDS.nodePoolSizing).toBe(0.6);
    expect(GATE_THRESHOLDS.globalFloor).toBe(0.5);
  });

  it("resize topology thresholds sit between nodePoolSizing and moduleSelection/region-selection risk-wise", () => {
    expect(GATE_THRESHOLDS.resizeTopologySuggest).toBeGreaterThan(GATE_THRESHOLDS.nodePoolSizing);
    expect(GATE_THRESHOLDS.resizeTopologySuggest).toBeLessThan(GATE_THRESHOLDS.resizeTopologyAutoApply);
    expect(GATE_THRESHOLDS.resizeTopologyAutoApply).toBeLessThanOrEqual(GATE_THRESHOLDS.moduleSelection);
  });
});

describe("applyGate", () => {
  it("passes when value meets the threshold exactly", () => {
    const gate = applyGate(0.95, 0.95, "residencyOk");
    expect(gate).toEqual({ value: 0.95, threshold: 0.95, passed: true });
  });

  it("passes when value exceeds the threshold", () => {
    const gate = applyGate(0.99, 0.9, "regionSelection");
    expect(gate.passed).toBe(true);
  });

  it("fails when value is below the threshold", () => {
    const gate = applyGate(0.89, 0.9, "regionSelection");
    expect(gate.passed).toBe(false);
    expect(gate.value).toBe(0.89);
    expect(gate.threshold).toBe(0.9);
  });

  it("throws on an out-of-range value", () => {
    expect(() => applyGate(1.5, 0.9, "bad")).toThrow(/probability/);
    expect(() => applyGate(-0.1, 0.9, "bad")).toThrow(/probability/);
    expect(() => applyGate(Number.NaN, 0.9, "bad")).toThrow(/probability/);
  });

  it("throws on an out-of-range threshold", () => {
    expect(() => applyGate(0.5, 1.2, "bad")).toThrow(/threshold/);
  });
});

describe("breachesGlobalFloor", () => {
  it("is true strictly below 0.50", () => {
    expect(breachesGlobalFloor(0.49)).toBe(true);
  });
  it("is false at or above 0.50", () => {
    expect(breachesGlobalFloor(0.5)).toBe(false);
    expect(breachesGlobalFloor(0.9)).toBe(false);
  });
});

describe("regionSelectionThreshold", () => {
  it("uses the stricter new-cluster threshold when not an incumbent", () => {
    expect(regionSelectionThreshold(false)).toBe(GATE_THRESHOLDS.newClusterRegionSelection);
  });
  it("uses the looser incumbent threshold when it is an incumbent stack", () => {
    expect(regionSelectionThreshold(true)).toBe(GATE_THRESHOLDS.incumbentRegionSelection);
  });
});
