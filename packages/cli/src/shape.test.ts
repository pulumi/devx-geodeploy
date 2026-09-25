import { describe, expect, it } from "vitest";
import { parseShape } from "./shape.js";

describe("parseShape", () => {
  it("parses a valid shape string", () => {
    expect(parseShape("4vcpu-16gb")).toEqual({ vcpu: 4, memGiB: 16 });
    expect(parseShape("1vcpu-2gb")).toEqual({ vcpu: 1, memGiB: 2 });
    expect(parseShape("0.5vcpu-1.5gb")).toEqual({ vcpu: 0.5, memGiB: 1.5 });
  });

  it("is case-insensitive", () => {
    expect(parseShape("4VCPU-16GB")).toEqual({ vcpu: 4, memGiB: 16 });
  });

  it("throws a clear error for a malformed shape", () => {
    expect(() => parseShape("not-a-shape")).toThrow(/Invalid --shape/);
    expect(() => parseShape("4-16")).toThrow(/Invalid --shape/);
  });
});
