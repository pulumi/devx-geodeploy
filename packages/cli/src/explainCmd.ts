import { readFile } from "node:fs/promises";
import type { DecisionRecord, DeploymentPlan } from "@geodeploy/core";
import { DeploymentPlanSchema } from "@geodeploy/core";

export interface RunExplainOptions {
  planPath: string;
}

export interface RunExplainResult {
  plan: DeploymentPlan;
  text: string;
}

/**
 * TypeSafe answers vary in shape by question primitive (choice/score/noul) —
 * this renders whichever fields are actually present rather than assuming
 * one shape. Answers are preserved on the decision record even when the AI
 * path aborted into a fallback (see @geodeploy/decide's AiPathAborted), so
 * this can show a real, low-confidence model response right alongside the
 * fallback that overrode it.
 */
function formatAnswer(name: string, answer: unknown): string {
  if (typeof answer !== "object" || answer === null) {
    return `      - ${name}: ${JSON.stringify(answer)}`;
  }
  const a = answer as Record<string, unknown>;
  const confidence = typeof a["confidence"] === "number" ? (a["confidence"] as number).toFixed(2) : undefined;
  if (typeof a["score"] === "number") {
    return `      - ${name}: score=${(a["score"] as number).toFixed(2)}${confidence ? ` confidence=${confidence}` : ""}`;
  }
  if (typeof a["noul"] === "number") {
    return `      - ${name}: noul=${(a["noul"] as number).toFixed(2)}`;
  }
  if (typeof a["choice"] === "string") {
    return `      - ${name}: choice=${a["choice"]}${confidence ? ` confidence=${confidence}` : ""}`;
  }
  return `      - ${name}: ${JSON.stringify(answer)}`;
}

function explainRecord(record: DecisionRecord): string[] {
  const lines: string[] = [];
  lines.push(`    mode: ${record.mode}`);
  lines.push(`    selection: ${record.selection.provider}:${record.selection.region}`);
  if (record.composite !== undefined) {
    lines.push(`    composite score: ${record.composite.toFixed(3)}`);
  }
  if (record.gates) {
    lines.push(`    gates:`);
    for (const [name, gate] of Object.entries(record.gates)) {
      lines.push(`      - ${name}: ${gate.value.toFixed(2)} vs threshold ${gate.threshold.toFixed(2)} -> ${gate.passed ? "PASS" : "FAIL"}`);
    }
  }
  if (record.answers) {
    lines.push(`    answers:`);
    for (const [name, answer] of Object.entries(record.answers)) {
      lines.push(formatAnswer(name, answer));
    }
  }
  lines.push(`    reason: ${record.reason}`);
  return lines;
}

/** Human-focused, more detailed than plan.md's summary table. */
export function formatExplain(plan: DeploymentPlan): string {
  const lines: string[] = [];
  lines.push(`GeoDeploy plan explanation — request ${plan.requestId} (created ${plan.createdAt})`);
  lines.push("");

  if (plan.notes.length > 0) {
    lines.push("NOTES:");
    for (const note of plan.notes) lines.push(`  - ${note}`);
    lines.push("");
  }

  const recordsByGeo = new Map<string, DecisionRecord[]>();
  for (const record of plan.decisionRecords) {
    const list = recordsByGeo.get(record.geoId) ?? [];
    list.push(record);
    recordsByGeo.set(record.geoId, list);
  }

  for (const region of plan.regions) {
    lines.push(`GEO ${region.geoId}:`);
    lines.push(`  chosen: ${region.provider}:${region.region} sku=${region.sku} nodes=${region.nodesNeeded} $${region.monthlyUsd.toFixed(2)}/mo provisionable=${region.provisionable}`);
    lines.push(`  modules: cluster=${region.modules.cluster} registry=${region.modules.registry} ingress=${region.modules.ingress} autoscaling=${region.modules.autoscaling} sizing=${region.modules.sizing}`);
    const records = recordsByGeo.get(region.geoId) ?? [];
    if (records.length === 0) {
      lines.push("  (no decision record found)");
    } else {
      records.forEach((record, i) => {
        lines.push(`  decision record #${i + 1}:`);
        lines.push(...explainRecord(record));
      });
    }
    lines.push("");
  }

  lines.push(`DNS: backend=${plan.dns.provider ?? "none"} reason=${plan.dns.reason}`);
  lines.push(`ALLOWED PROVIDERS: ${plan.allowedProviders.join(", ") || "none"}`);
  lines.push(`DETECTED PROVIDERS (tier1): ${plan.detectedProviders.join(", ") || "none"}`);
  lines.push(`TOTAL MONTHLY COST: $${plan.totalMonthlyUsd.toFixed(2)}`);

  return lines.join("\n") + "\n";
}

export async function runExplain(opts: RunExplainOptions): Promise<RunExplainResult> {
  const raw = await readFile(opts.planPath, "utf8");
  const plan = DeploymentPlanSchema.parse(JSON.parse(raw));
  return { plan, text: formatExplain(plan) };
}
