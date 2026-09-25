import { describe, expect, it } from "vitest";
import { platformsToArches } from "./arch.js";

describe("platformsToArches", () => {
  it("maps known Docker platform strings to Arch values", () => {
    expect(platformsToArches(["linux/amd64"])).toEqual(["x86_64"]);
    expect(platformsToArches(["linux/arm64"])).toEqual(["arm64"]);
  });

  it("de-duplicates and preserves both when both platforms are present", () => {
    const arches = platformsToArches(["linux/amd64", "linux/arm64", "linux/amd64"]);
    expect(new Set(arches)).toEqual(new Set(["x86_64", "arm64"]));
    expect(arches).toHaveLength(2);
  });

  it("drops unrecognized platform strings rather than guessing", () => {
    expect(platformsToArches(["linux/riscv64"])).toEqual([]);
    expect(platformsToArches(["linux/amd64", "linux/riscv64"])).toEqual(["x86_64"]);
  });

  it("returns an empty array for no platforms", () => {
    expect(platformsToArches([])).toEqual([]);
  });
});
