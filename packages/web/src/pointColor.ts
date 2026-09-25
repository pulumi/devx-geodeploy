import { theme } from "./theme";
import type { ApplyRecord, RegionPlan } from "./types";

/**
 * `apply.json` is never cleared or invalidated when a new plan supersedes
 * it — the wizard's `POST /api/plan` only ever writes `plan.json`. Two plans
 * can reuse the same geoId across totally different revisions (e.g. two
 * different wizard submissions both happening to include "eu-west"), so a
 * per-region apply result is only actually about the *currently loaded*
 * plan when its `requestId` matches. Every consumer of an `ApplyRecord`
 * must check this before treating it as current — this is the one place
 * that check lives, so Sidebar/Globe/RegionModal can't disagree about it.
 */
export function isApplyStale(apply: ApplyRecord | null, planRequestId: string): boolean {
  return apply !== null && apply.requestId !== planRequestId;
}

/** Shared by Sidebar (status pill) and Globe (deployment-point color) so the two never disagree. */
export function pointColor(region: RegionPlan, apply: ApplyRecord | null, planRequestId: string): string {
  if (!apply || apply.refused || isApplyStale(apply, planRequestId)) return theme.color.notAppliedPin;
  const result = apply.results?.[region.geoId];
  if (result?.status === "succeeded") return theme.color.successBadge;
  if (result?.status === "failed") return theme.color.failureBadge;
  return theme.color.notAppliedPin;
}

/**
 * The real, live IP/hostname a region's traffic actually lands on — read
 * straight from `ingressK8sServiceLb`'s own Pulumi stack output (see
 * packages/modules/src/ingress/service-lb.ts), which itself comes directly
 * from the cloud load balancer's `status.loadBalancer.ingress` entry. Never
 * fabricated: `null` whenever apply hasn't recorded a real value here yet
 * (still an untyped stack output — `outputs: Record<string, unknown>` — so
 * this is the one place that narrows it to a string, shared by Sidebar and
 * Globe so they can't disagree).
 */
export function endpointFor(region: RegionPlan, apply: ApplyRecord | null, planRequestId: string): string | null {
  if (!apply || apply.refused || isApplyStale(apply, planRequestId)) return null;
  const result = apply.results?.[region.geoId];
  if (result?.status !== "succeeded") return null;
  const endpoint = result.outputs?.["externalEndpoint"];
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
}

export type PointStatus = "succeeded" | "failed" | "not-applied";

export function pointStatus(region: RegionPlan, apply: ApplyRecord | null, planRequestId: string): PointStatus {
  if (!apply || apply.refused || isApplyStale(apply, planRequestId)) return "not-applied";
  const result = apply.results?.[region.geoId];
  if (result?.status === "succeeded") return "succeeded";
  if (result?.status === "failed") return "failed";
  return "not-applied";
}
