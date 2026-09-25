import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { CandidateCost, DeploymentPlan, DeploymentRequest } from "@geodeploy/core";
import { platformsToArches } from "@geodeploy/cost";
import { buildDeploymentPlan } from "@geodeploy/decide";
import { detectDnsReadiness, detectProviderReadiness } from "@geodeploy/detect";
import { renderPlanJson, renderPlanMarkdown } from "@geodeploy/report";
import { type BuildPriceGroupsOptions, buildDefaultPricingSources, priceAndRankForGeo } from "./pricingPipeline.js";
import { loadDeploymentRequest } from "./request.js";

/**
 * Prices and ranks candidates for every target geo, runs tier-1-only
 * readiness detection (this is `plan`, not `apply` — no network identity
 * checks here), and assembles the full `DeploymentPlan`.
 */
export async function buildPlanFromRequest(
  request: DeploymentRequest,
  pricingOpts: BuildPriceGroupsOptions = {},
): Promise<DeploymentPlan> {
  // Hard architecture-compatibility filter: a candidate whose only viable
  // SKU is an architecture this image was never built for cannot run it at
  // all (see @geodeploy/cost's platformsToArches/pickCheapestSku) — this
  // must be enforced here, before candidates ever reach decide, so it
  // applies uniformly whether decide ends up using the live TypeSafe path
  // or the deterministic fallback.
  const allowedArches = platformsToArches(request.image.platforms);

  // Every geo prices the same catalog of candidate regions (only distance
  // varies by geo, not the underlying price data) — sharing one set of
  // sources/caches across the whole loop, not just within a single geo's
  // own call, is what turns the second-and-later geo's fetches into cheap
  // in-memory cache hits instead of independently re-parsing the same
  // multi-hundred-MB AWS offer files all over again.
  const pricing: BuildPriceGroupsOptions = {
    ...pricingOpts,
    sources: pricingOpts.sources ?? buildDefaultPricingSources(),
  };

  const candidatesByGeo: Record<string, CandidateCost[]> = {};
  for (const geo of request.targetGeos) {
    candidatesByGeo[geo.id] = await priceAndRankForGeo(
      geo.centroid,
      request.workload,
      request.constraints.allowedProviders,
      pricing,
      allowedArches,
    );
  }

  const [providerReadiness, dnsReadiness] = await Promise.all([detectProviderReadiness(), detectDnsReadiness()]);

  return buildDeploymentPlan({
    request,
    candidatesByGeo,
    providerReadiness,
    dnsReadiness,
  });
}

export interface RunPlanOptions {
  requestPath: string;
  outDir?: string;
  pricing?: BuildPriceGroupsOptions;
}

export interface RunPlanResult {
  plan: DeploymentPlan;
  planJsonPath: string;
  planMdPath: string;
}

/**
 * Runs the real pricing/decision pipeline against an in-memory
 * `DeploymentRequest` and writes `plan.json`/`plan.md` to `outDir`. This is
 * the one place that logic lives — both the CLI's `runPlan` (file-path
 * input) and the `geodeploy ui` server's `POST /api/plan` (wizard input)
 * call this directly, so a browser-submitted plan runs the *identical*
 * pipeline a CLI-submitted one does, never a reimplementation of it.
 */
export async function runPlanFromRequest(
  request: DeploymentRequest,
  outDir: string,
  pricingOpts?: BuildPriceGroupsOptions,
): Promise<RunPlanResult> {
  const plan = await buildPlanFromRequest(request, pricingOpts);

  await mkdir(outDir, { recursive: true });
  const planJsonPath = path.join(outDir, "plan.json");
  const planMdPath = path.join(outDir, "plan.md");
  await writeFile(planJsonPath, renderPlanJson(plan), "utf8");
  await writeFile(planMdPath, renderPlanMarkdown(plan), "utf8");

  return { plan, planJsonPath, planMdPath };
}

export async function runPlan(opts: RunPlanOptions): Promise<RunPlanResult> {
  const request = await loadDeploymentRequest(opts.requestPath);
  return runPlanFromRequest(request, opts.outDir ?? process.cwd(), opts.pricing);
}
