import { describe, expect, it } from "vitest";
import {
  composite,
  DEFAULT_WEIGHT_PROFILE,
  norm,
  resolveWeights,
  SCORE_MAX_INDEX,
  WEIGHT_PROFILES,
} from "./composite.js";

describe("norm", () => {
  it("maps 0 to 0 and the max index to 1", () => {
    expect(norm(0)).toBe(0);
    expect(norm(SCORE_MAX_INDEX)).toBe(1);
  });

  it("scales linearly in between", () => {
    expect(norm(4.5)).toBeCloseTo(0.5, 5);
  });

  it("clamps out-of-range values", () => {
    expect(norm(-3)).toBe(0);
    expect(norm(100)).toBe(1);
  });

  it("supports a custom maxIndex", () => {
    expect(norm(1, 2)).toBeCloseTo(0.5, 5);
  });

  it("throws for a non-positive maxIndex", () => {
    expect(() => norm(1, 0)).toThrow();
  });
});

describe("WEIGHT_PROFILES", () => {
  it("has exactly the four named presets", () => {
    expect(Object.keys(WEIGHT_PROFILES).sort()).toEqual(
      ["balanced", "failure-domain", "latency-optimized", "residency-first"].sort(),
    );
  });

  it("every profile's five weights sum to 1.0", () => {
    for (const [name, w] of Object.entries(WEIGHT_PROFILES)) {
      const sum = w.cost + w.coverage + w.maturity + w.sprawl + w.archConsistency;
      expect(sum, `profile ${name}`).toBeCloseTo(1.0, 10);
    }
  });

  it("defaults to latency-optimized, with coverage dominating", () => {
    expect(DEFAULT_WEIGHT_PROFILE).toBe("latency-optimized");
    const w = WEIGHT_PROFILES["latency-optimized"];
    expect(w.coverage).toBeGreaterThan(w.cost);
    expect(w.coverage).toBeGreaterThan(w.maturity);
    expect(w.coverage).toBeGreaterThan(w.sprawl);
    expect(w.coverage).toBeGreaterThan(w.archConsistency);
    expect(w.coverage).toBeGreaterThanOrEqual(0.45);
  });
});

describe("resolveWeights", () => {
  it("resolves the default profile when none is given", () => {
    expect(resolveWeights()).toEqual(WEIGHT_PROFILES[DEFAULT_WEIGHT_PROFILE]);
  });

  it("throws for an unknown profile", () => {
    // @ts-expect-error deliberately invalid profile name
    expect(() => resolveWeights("nonexistent")).toThrow(/unknown weight profile/);
  });
});

describe("composite", () => {
  it("computes the weighted sum with sprawl subtracted", () => {
    const weights = { cost: 0.2, coverage: 0.2, maturity: 0.2, sprawl: 0.2, archConsistency: 0.2 };
    // all dimensions at max (9) except sprawlRisk also at max (9, i.e. worst)
    const value = composite({ costFit: 9, coverage: 9, maturity: 9, sprawlRisk: 9, archConsistency: 9 }, weights);
    // 0.2*1 + 0.2*1 + 0.2*1 + 0.2*1 - 0.2*1 = 0.6
    expect(value).toBeCloseTo(0.6, 10);
  });

  it("a perfect candidate (max score, zero sprawl) scores the combined non-sprawl weight (sprawl contributes nothing when it's 0)", () => {
    const weights = { cost: 0.2, coverage: 0.2, maturity: 0.2, sprawl: 0.2, archConsistency: 0.2 };
    const value = composite({ costFit: 9, coverage: 9, maturity: 9, sprawlRisk: 0, archConsistency: 9 }, weights);
    // .2 + .2 + .2 + .2 - .2*0 = 0.8 — the theoretical max is 1.0 only when
    // the sprawl weight is 0; here it's a real penalty weight that simply
    // isn't triggered because sprawlRisk itself is 0.
    expect(value).toBeCloseTo(0.8, 10);
  });

  it("higher sprawlRisk strictly lowers the composite, all else equal", () => {
    const weights = WEIGHT_PROFILES.balanced;
    const low = composite({ costFit: 6, coverage: 6, maturity: 6, sprawlRisk: 1, archConsistency: 6 }, weights);
    const high = composite({ costFit: 6, coverage: 6, maturity: 6, sprawlRisk: 8, archConsistency: 6 }, weights);
    expect(high).toBeLessThan(low);
  });

  it("higher archConsistency strictly raises the composite, all else equal", () => {
    const weights = WEIGHT_PROFILES.balanced;
    const low = composite({ costFit: 6, coverage: 6, maturity: 6, sprawlRisk: 3, archConsistency: 1 }, weights);
    const high = composite({ costFit: 6, coverage: 6, maturity: 6, sprawlRisk: 3, archConsistency: 8 }, weights);
    expect(high).toBeGreaterThan(low);
  });

  it("re-ranking under a different profile requires no new API call — same inputs, different weights", () => {
    const inputs = { costFit: 3, coverage: 9, maturity: 5, sprawlRisk: 7, archConsistency: 4 };
    const latency = composite(inputs, WEIGHT_PROFILES["latency-optimized"]);
    const residencyFirst = composite(inputs, WEIGHT_PROFILES["residency-first"]);
    // Same raw scores, different weights -> different composite.
    expect(latency).not.toBeCloseTo(residencyFirst, 5);
  });
});
