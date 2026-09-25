import type { DeploymentPlan } from "@geodeploy/core";

/** Pretty-printed JSON — this is literally the content of `plan.json`. */
export function renderPlanJson(plan: DeploymentPlan): string {
  return JSON.stringify(plan, null, 2) + "\n";
}
