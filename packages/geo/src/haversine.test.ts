import { describe, expect, it } from "vitest";
import { haversineDistanceKm } from "./haversine.js";

describe("haversineDistanceKm", () => {
  it("returns ~0 for identical points", () => {
    expect(haversineDistanceKm({ lat: 51.5072, lon: -0.1276 }, { lat: 51.5072, lon: -0.1276 })).toBeCloseTo(0, 3);
  });

  it("matches known London-Paris distance (~344km)", () => {
    const london = { lat: 51.5072, lon: -0.1276 };
    const paris = { lat: 48.8566, lon: 2.3522 };
    expect(haversineDistanceKm(london, paris)).toBeCloseTo(344, -1);
  });

  it("matches known New York-Los Angeles distance (~3936km)", () => {
    const nyc = { lat: 40.7128, lon: -74.006 };
    const la = { lat: 34.0522, lon: -118.2437 };
    const d = haversineDistanceKm(nyc, la);
    expect(d).toBeGreaterThan(3900);
    expect(d).toBeLessThan(3970);
  });

  it("matches known Singapore-Tokyo distance (~5300km)", () => {
    const sg = { lat: 1.3521, lon: 103.8198 };
    const tokyo = { lat: 35.6762, lon: 139.6503 };
    const d = haversineDistanceKm(sg, tokyo);
    expect(d).toBeGreaterThan(5200);
    expect(d).toBeLessThan(5400);
  });

  it("is symmetric", () => {
    const a = { lat: 10, lon: 20 };
    const b = { lat: -5, lon: 100 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 6);
  });
});
