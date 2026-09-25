import type { ConfidenceGate, DecisionRecord, DeploymentPlan, RegionPlan } from "@geodeploy/core";

function gateLine(name: string, gate: ConfidenceGate): string {
  const status = gate.passed ? "PASS" : "FAIL";
  return `  - gate \`${name}\`: ${gate.value.toFixed(2)} vs threshold ${gate.threshold.toFixed(2)} -> **${status}**`;
}

function renderDecisionRecord(record: DecisionRecord): string {
  const lines: string[] = [];
  lines.push(`- **mode:** ${record.mode}`);
  lines.push(`- **selection:** ${record.selection.provider}:${record.selection.region}`);
  if (record.composite !== undefined) {
    lines.push(`- **composite score:** ${record.composite.toFixed(3)}`);
  }
  if (record.gates) {
    lines.push(`- **gates:**`);
    for (const [name, gate] of Object.entries(record.gates)) {
      lines.push(gateLine(name, gate));
    }
  }
  lines.push(`- **reason:** ${record.reason}`);
  return lines.join("\n");
}

function regionsTable(regions: readonly RegionPlan[]): string {
  const header = "| Geo | Provider | Region | SKU | Nodes | Monthly USD | Provisionable |";
  const sep = "|---|---|---|---|---|---|---|";
  const rows = regions.map(
    (r) =>
      `| ${r.geoId} | ${r.provider} | ${r.region} | ${r.sku} | ${r.nodesNeeded} | $${r.monthlyUsd.toFixed(2)} | ${r.provisionable ? "yes" : "no"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

/** Human-readable `plan.md`. */
export function renderPlanMarkdown(plan: DeploymentPlan): string {
  const sections: string[] = [];

  sections.push(`# GeoDeploy Deployment Plan`);
  sections.push(`**Request ID:** \`${plan.requestId}\`  \n**Created:** ${plan.createdAt}`);

  // Notes rendered prominently, right up top — never buried at the bottom.
  if (plan.notes.length > 0) {
    sections.push(
      [`## Notes`, ...plan.notes.map((n) => `> ${n}`)].join("\n\n"),
    );
  }

  sections.push([`## Regions`, regionsTable(plan.regions)].join("\n\n"));

  const recordsByGeo = new Map<string, DecisionRecord[]>();
  for (const record of plan.decisionRecords) {
    const list = recordsByGeo.get(record.geoId) ?? [];
    list.push(record);
    recordsByGeo.set(record.geoId, list);
  }

  const decisionSections = plan.regions.map((region) => {
    const records = recordsByGeo.get(region.geoId) ?? [];
    const body = records.length > 0 ? records.map(renderDecisionRecord).join("\n\n") : "_no decision record found_";
    return [`### ${region.geoId}`, body].join("\n\n");
  });
  sections.push([`## Decision detail (including runner-ups and why they lost)`, ...decisionSections].join("\n\n"));

  sections.push(
    [
      `## DNS`,
      `**Backend:** ${plan.dns.provider ?? "none selected"}`,
      `**Reason:** ${plan.dns.reason}`,
    ].join("\n\n"),
  );

  sections.push(
    [
      `## Providers`,
      `**Allowed:** ${plan.allowedProviders.join(", ") || "none"}`,
      `**Detected (tier1):** ${plan.detectedProviders.join(", ") || "none"}`,
    ].join("\n\n"),
  );

  sections.push(`## Total monthly cost\n\n**$${plan.totalMonthlyUsd.toFixed(2)}/month**`);

  return sections.join("\n\n") + "\n";
}
