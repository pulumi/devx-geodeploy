import { readFile } from "node:fs/promises";
import { DeploymentPlanSchema } from "@geodeploy/core";
import { checkApplyReadiness } from "@geodeploy/provision";

export interface RunDestroyOptions {
  planPath: string;
}

export interface RunDestroyResult {
  refused: boolean;
  blockers: string[];
}

/**
 * Same readiness-gating pattern as `apply`. Real teardown execution is
 * deliberately not implemented anywhere in `@geodeploy/provision` yet — it is
 * deferred to the same credential-gated tier as real `apply` execution — so
 * this always refuses, whether the block is missing credentials (today's
 * only real case) or the not-yet-built teardown path itself.
 */
export async function runDestroy(opts: RunDestroyOptions): Promise<RunDestroyResult> {
  const raw = await readFile(opts.planPath, "utf8");
  const plan = DeploymentPlanSchema.parse(JSON.parse(raw));

  const readiness = await checkApplyReadiness(plan);
  if (!readiness.ready) {
    return { refused: true, blockers: readiness.blockers };
  }

  return {
    refused: true,
    blockers: [
      "real `destroy` execution is not yet implemented in @geodeploy/provision — deferred to the same " +
        "credential-gated tier as real `apply` execution",
    ],
  };
}
