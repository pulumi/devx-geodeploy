import { describe, expect, it } from "vitest";
import { parseDockerfile } from "./dockerfileParser";

describe("parseDockerfile", () => {
  it("defaults to the two-platform fallback when no --platform is pinned", () => {
    const dockerfile = ["FROM node:20-alpine", "WORKDIR /app", "COPY . .", "CMD [\"node\", \"index.js\"]"].join("\n");
    const result = parseDockerfile(dockerfile);
    expect(result.platforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(result.baseImages).toEqual(["node:20-alpine"]);
  });

  it("collects every FROM line's base image across a multi-stage build", () => {
    const dockerfile = [
      "FROM golang:1.22 AS builder",
      "WORKDIR /src",
      "COPY . .",
      "RUN go build -o /app",
      "",
      "FROM alpine:3.19",
      "COPY --from=builder /app /app",
      'CMD ["/app"]',
    ].join("\n");
    const result = parseDockerfile(dockerfile);
    expect(result.baseImages).toEqual(["golang:1.22", "alpine:3.19"]);
    // No --platform pin anywhere, so still falls back to the default pair.
    expect(result.platforms).toEqual(["linux/amd64", "linux/arm64"]);
  });

  it("detects an explicit --platform pin on a FROM line", () => {
    const dockerfile = ["FROM --platform=linux/arm64 golang:1.22 AS builder", "FROM alpine:3.19"].join("\n");
    const result = parseDockerfile(dockerfile);
    expect(result.platforms).toEqual(["linux/arm64"]);
    expect(result.baseImages).toEqual(["golang:1.22", "alpine:3.19"]);
  });

  it("de-duplicates repeated --platform pins across multiple FROM lines", () => {
    const dockerfile = [
      "FROM --platform=linux/amd64 golang:1.22 AS builder",
      "FROM --platform=linux/amd64 alpine:3.19",
    ].join("\n");
    const result = parseDockerfile(dockerfile);
    expect(result.platforms).toEqual(["linux/amd64"]);
  });

  it("handles mixed-case FROM/AS keywords (Docker itself is case-insensitive)", () => {
    const dockerfile = ["from node:20-alpine as build", "WORKDIR /app"].join("\n");
    const result = parseDockerfile(dockerfile);
    expect(result.baseImages).toEqual(["node:20-alpine"]);
    expect(result.platforms).toEqual(["linux/amd64", "linux/arm64"]);
  });
});
