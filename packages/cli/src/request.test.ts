import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDeploymentRequest, resolveGeoIds } from "./request.js";

describe("loadDeploymentRequest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-request-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function baseRequest(targetGeos: unknown[]): unknown {
    return {
      targetGeos,
      image: { reference: "example/app:1.0", platforms: ["linux/amd64"] },
      workload: {
        manifests: ["a.yaml"],
        replicasPerRegion: 1,
        requestsPerPod: { vcpu: 1, memGiB: 2 },
        egressGiBPerMonth: 0,
        storageGiB: 0,
      },
    };
  }

  it("auto-fills centroid and residency from normalizeGeo when omitted", async () => {
    const filePath = path.join(tmpDir, "req.json");
    await writeFile(filePath, JSON.stringify(baseRequest([{ id: "eu-central", weightPct: 100 }])), "utf8");

    const request = await loadDeploymentRequest(filePath);
    expect(request.targetGeos[0]?.centroid).toEqual({ lat: 50.1109, lon: 8.6821 });
    expect(request.targetGeos[0]?.residency).toBe("eu-only");
  });

  it("leaves an explicit centroid untouched", async () => {
    const filePath = path.join(tmpDir, "req.json");
    await writeFile(
      filePath,
      JSON.stringify(baseRequest([{ id: "custom", centroid: { lat: 1, lon: 2 }, weightPct: 100 }])),
      "utf8",
    );

    const request = await loadDeploymentRequest(filePath);
    expect(request.targetGeos[0]?.centroid).toEqual({ lat: 1, lon: 2 });
  });

  it("throws a clear error for an id with no centroid that doesn't resolve", async () => {
    const filePath = path.join(tmpDir, "req.json");
    await writeFile(filePath, JSON.stringify(baseRequest([{ id: "not-a-real-geo", weightPct: 100 }])), "utf8");

    await expect(loadDeploymentRequest(filePath)).rejects.toThrow(/does not resolve via normalizeGeo/);
  });
});

describe("resolveGeoIds", () => {
  it("resolves known ids into full TargetGeo entries with equal weightPct", () => {
    const geos = resolveGeoIds(["eu-central", "us-east"]);
    expect(geos).toHaveLength(2);
    expect(geos[0]).toMatchObject({ id: "eu-central", weightPct: 50, centroid: { lat: 50.1109, lon: 8.6821 } });
    expect(geos[1]).toMatchObject({ id: "us-east", weightPct: 50 });
  });

  it("splits weightPct evenly across any number of geos", () => {
    const geos = resolveGeoIds(["eu-central", "us-east", "apac-se"]);
    expect(geos.map((g) => g.weightPct)).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it("throws a clear error listing known ids for an unresolvable id", () => {
    expect(() => resolveGeoIds(["not-a-real-geo"])).toThrow(/Unknown geo id "not-a-real-geo"/);
  });

  it("throws for an empty list rather than silently producing a plan with no geos", () => {
    expect(() => resolveGeoIds([])).toThrow(/must not be empty/);
  });
});
