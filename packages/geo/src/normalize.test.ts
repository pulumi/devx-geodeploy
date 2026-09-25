import { describe, expect, it } from "vitest";
import { knownGeoIds, normalizeGeo } from "./normalize.js";

describe("normalizeGeo", () => {
  it("resolves a known business geo id", () => {
    const geo = normalizeGeo("eu-central");
    expect(geo).toBeDefined();
    expect(geo?.continent).toBe("Europe");
    expect(geo?.residency).toBe("eu-only");
  });

  it("resolves a known ISO-3166 country code", () => {
    const geo = normalizeGeo("JP");
    expect(geo).toBeDefined();
    expect(geo?.continent).toBe("Asia");
  });

  it("returns undefined for an unknown id rather than guessing", () => {
    expect(normalizeGeo("not-a-real-geo")).toBeUndefined();
  });

  it("exposes the full set of known ids", () => {
    const ids = knownGeoIds();
    expect(ids).toContain("us-east");
    expect(ids.length).toBeGreaterThan(5);
  });
});
