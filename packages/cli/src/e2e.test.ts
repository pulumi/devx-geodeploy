import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentPlanSchema } from "@geodeploy/core";
import { aws, azure } from "@geodeploy/pricing";
import { runApply } from "./applyCmd.js";
import { runDestroy } from "./destroyCmd.js";
import { buildPlanFromRequest } from "./planCmd.js";
import { runPrice } from "./priceCmd.js";
import { loadDeploymentRequest } from "./request.js";

// Same fixture convention the pricing package's own tests use: small,
// recorded (AWS/Azure) or hand-built (GCP) snapshots, read straight off
// disk — no network anywhere in this test file.
const AWS_FIXTURE_DIR = fileURLToPath(new URL("../../../test/fixtures/aws", import.meta.url));
const AZURE_FIXTURE_DIR = fileURLToPath(new URL("../../../test/fixtures/azure", import.meta.url));
const EXAMPLE_REQUEST_PATH = fileURLToPath(new URL("../../../examples/sample-request.json", import.meta.url));

function fixturePricingOptions() {
  return {
    sources: {
      awsSource: aws.createFixtureAwsOfferSource(AWS_FIXTURE_DIR),
      azureSource: azure.createFixtureAzureRetailPriceSource(AZURE_FIXTURE_DIR),
      // GCP has no live-without-a-key path; getGcpPriceQuote already defaults
      // to its own fixture source whenever GOOGLE_API_KEY is unset, so no
      // explicit gcpSource is needed here as long as that env var stays unset.
    },
    // Expected: most of the 36 catalog regions have no matching fixture file
    // at all, so most SKU fetches for this run fail by design and are
    // silently skipped rather than crashing the whole plan. Swallow them
    // here to keep test output clean; the pipeline's own skip-with-warning
    // behavior is exercised by these calls simply not throwing.
    onSkuWarning: () => {},
  };
}

describe("CLI end-to-end offline smoke test", () => {
  let tmpDir: string;
  let originalGoogleApiKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "geodeploy-cli-e2e-"));
    originalGoogleApiKey = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalGoogleApiKey !== undefined) process.env["GOOGLE_API_KEY"] = originalGoogleApiKey;
  });

  it("runs the full plan pipeline against the example request, fully offline", async () => {
    const request = await loadDeploymentRequest(EXAMPLE_REQUEST_PATH);
    expect(request.targetGeos.map((g) => g.id)).toEqual(["eu-central", "us-east"]);
    // Auto-filled centroid from normalizeGeo, per the loader's convenience behavior.
    expect(request.targetGeos[0]?.centroid).toEqual({ lat: 50.1109, lon: 8.6821 });

    const plan = await buildPlanFromRequest(request, fixturePricingOptions());

    // Schema-valid (buildDeploymentPlan already validates internally; re-validate
    // independently here as the thing this test is actually asserting).
    expect(() => DeploymentPlanSchema.parse(plan)).not.toThrow();

    expect(plan.regions.length).toBe(2);
    // No configured providers detected anywhere in this environment.
    for (const region of plan.regions) {
      expect(region.provisionable).toBe(false);
    }
    expect(plan.detectedProviders).toEqual([]);
    expect(plan.notes.some((n) => n.includes("No configured providers detected"))).toBe(true);
    // No TYPESAFE_API_KEY in this environment -> deterministic fallback path.
    expect(plan.decisionRecords.every((r) => r.mode === "deterministic-fallback")).toBe(true);

    const planPath = path.join(tmpDir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    return planPath;
  });

  it("produces a plan.json that geodeploy apply cleanly refuses, without ever touching Pulumi", async () => {
    const request = await loadDeploymentRequest(EXAMPLE_REQUEST_PATH);
    const plan = await buildPlanFromRequest(request, fixturePricingOptions());
    const planPath = path.join(tmpDir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const result = await runApply({ planPath, outDir: tmpDir });

    expect(result.refused).toBe(true);
    expect(result.provisionResult).toBeUndefined();
    // Specific, per-provider blocker messages — every distinct provider actually used in the plan.
    const usedProviders = new Set(plan.regions.map((r) => r.provider));
    for (const provider of usedProviders) {
      expect(result.blockers.some((b) => b.startsWith(`${provider}:`))).toBe(true);
    }

    // apply.json is a real, persisted artifact — even (especially) the refusal case.
    expect(result.applyJsonPath).toBe(path.join(tmpDir, "apply.json"));
    expect(result.applyRecord.refused).toBe(true);
    expect(result.applyRecord.requestId).toBe(plan.requestId);
    const written = JSON.parse(await readFile(result.applyJsonPath, "utf8"));
    expect(written).toEqual(result.applyRecord);
  });

  it("geodeploy destroy also refuses cleanly via the same readiness gate", async () => {
    const request = await loadDeploymentRequest(EXAMPLE_REQUEST_PATH);
    const plan = await buildPlanFromRequest(request, fixturePricingOptions());
    const planPath = path.join(tmpDir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const result = await runDestroy({ planPath });
    expect(result.refused).toBe(true);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("geodeploy price prints a ranked, sourced, realism-tagged table (fixture-backed offline)", async () => {
    const { candidates, table } = await runPrice({
      geoId: "eu-central",
      shape: "1vcpu-2gb",
      pricing: fixturePricingOptions(),
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(table).toContain("PROVIDER");
    expect(table).toContain("REALISM");
    expect(candidates.every((c) => c.realism === "live" || c.realism === "fixture")).toBe(true);
    // Fixture-backed sources for AWS/Azure -> those rows are tagged "fixture".
    expect(candidates.some((c) => c.provider === "azure" && c.realism === "fixture")).toBe(true);
  });

  it("rejects an unknown --geo with the list of known geo ids", async () => {
    await expect(runPrice({ geoId: "not-a-real-geo", shape: "1vcpu-2gb" })).rejects.toThrow(/Unknown --geo/);
  });
});
