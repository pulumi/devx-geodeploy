import { describe, expect, it } from "vitest";
import { bayerThreshold, polar2Cartesian, quantizeChannel } from "./labelSprite";

describe("polar2Cartesian", () => {
  it("places the north pole (lat=90) directly on +Y, independent of longitude", () => {
    const p = polar2Cartesian(90, 0, 100);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(100, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it("places lat=0, lng=0 on the +Z axis, matching three-globe's own convention", () => {
    const p = polar2Cartesian(0, 0, 100);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(100, 6);
  });

  it("scales linearly with the radius argument", () => {
    const p1 = polar2Cartesian(10, 20, 1);
    const p2 = polar2Cartesian(10, 20, 250);
    expect(p2.x).toBeCloseTo(p1.x * 250, 6);
    expect(p2.y).toBeCloseTo(p1.y * 250, 6);
    expect(p2.z).toBeCloseTo(p1.z * 250, 6);
  });
});

describe("bayerThreshold", () => {
  it("tiles the 4x4 matrix (period 4 in both axes)", () => {
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        expect(bayerThreshold(x, y)).toBeCloseTo(bayerThreshold(x + 4, y + 4), 10);
      }
    }
  });

  it("returns a distinct value in [0, 1) for every cell in one period", () => {
    const seen = new Set<number>();
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const t = bayerThreshold(x, y);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(1);
        seen.add(t);
      }
    }
    expect(seen.size).toBe(16);
  });

  it("handles negative coordinates the same as their positive-modulo equivalent", () => {
    expect(bayerThreshold(-1, -1)).toBeCloseTo(bayerThreshold(3, 3), 10);
  });
});

describe("quantizeChannel", () => {
  it("clamps to [0, 1]", () => {
    expect(quantizeChannel(-1, 0, 4)).toBe(0);
    expect(quantizeChannel(2, 0.999, 4)).toBe(1);
  });

  it("produces only levels-many distinct output values across the full input range", () => {
    const levels = 4;
    const outputs = new Set<number>();
    for (let i = 0; i <= 100; i++) {
      outputs.add(quantizeChannel(i / 100, 0.5, levels));
    }
    expect(outputs.size).toBeLessThanOrEqual(levels);
  });

  it("a higher threshold never produces a lower quantized value for the same input", () => {
    for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(quantizeChannel(v, 0.9, 4)).toBeGreaterThanOrEqual(quantizeChannel(v, 0.1, 4));
    }
  });
});
