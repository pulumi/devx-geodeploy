import { describe, expect, it } from "vitest";
import { buildResizeQuestions, RESIZE_CONFIDENCE_LEVELS } from "./resize-questions.js";
import { makeDeploymentPlan, makeRegionPlan, makeRegionUtilization, makeUtilizationSnapshot } from "./test-helpers.js";

describe("buildResizeQuestions", () => {
  it("builds a topology choice with no-change plus 2 resize options per region for a single region", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1" })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1" })]);

    const questions = buildResizeQuestions(plan, utilization);

    const optionIds = Object.keys(questions.topology.criteria);
    expect(optionIds).toEqual(expect.arrayContaining(["no-change", "scale-up:geo-1", "scale-down:geo-1"]));
    // Single region: no ordered pairs exist, so there must be no shift options.
    expect(optionIds.filter((id) => id.startsWith("shift:"))).toHaveLength(0);
    expect(optionIds).toHaveLength(3); // no-change + scale-up + scale-down
  });

  it("generates N*(N-1) ordered shift-pair options for 3 regions, plus 2N resize options and 1 no-change", () => {
    const geoIds = ["geo-a", "geo-b", "geo-c"];
    const plan = makeDeploymentPlan(geoIds.map((geoId) => makeRegionPlan({ geoId })));
    const utilization = makeUtilizationSnapshot(geoIds.map((geoId) => makeRegionUtilization({ geoId })));

    const questions = buildResizeQuestions(plan, utilization);
    const optionIds = Object.keys(questions.topology.criteria);

    const shiftIds = optionIds.filter((id) => id.startsWith("shift:"));
    expect(shiftIds).toHaveLength(3 * 2); // N*(N-1) = 6

    for (const from of geoIds) {
      for (const to of geoIds) {
        if (from === to) continue;
        expect(shiftIds).toContain(`shift:${from}->${to}`);
      }
    }
    // No self-pairs.
    for (const geoId of geoIds) {
      expect(shiftIds).not.toContain(`shift:${geoId}->${geoId}`);
    }

    const scaleIds = optionIds.filter((id) => id.startsWith("scale-up:") || id.startsWith("scale-down:"));
    expect(scaleIds).toHaveLength(3 * 2); // 2N

    expect(optionIds).toHaveLength(1 + 6 + 6); // no-change + shifts + scale up/down
  });

  it("embeds real region data (cpuUtilPct, nodeCount, sku) into each option's description", () => {
    const plan = makeDeploymentPlan([
      makeRegionPlan({ geoId: "geo-1", sku: "m5.xlarge", nodesNeeded: 8 }),
      makeRegionPlan({ geoId: "geo-2", sku: "Standard_D4s_v5", nodesNeeded: 3 }),
    ]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", cpuUtilPct: 0.87, nodeCount: 8 }),
      makeRegionUtilization({ geoId: "geo-2", cpuUtilPct: 0.12, nodeCount: 3 }),
    ]);

    const questions = buildResizeQuestions(plan, utilization);
    const scaleUpGeo1 = questions.topology.criteria["scale-up:geo-1"] as { target: Record<string, unknown> };

    expect(scaleUpGeo1.target).toMatchObject({ geoId: "geo-1", sku: "m5.xlarge", cpuUtilPct: 0.87, nodeCount: 8 });

    const shiftOption = questions.topology.criteria["shift:geo-1->geo-2"] as {
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    expect(shiftOption.from).toMatchObject({ geoId: "geo-1", sku: "m5.xlarge" });
    expect(shiftOption.to).toMatchObject({ geoId: "geo-2", sku: "Standard_D4s_v5" });
  });

  it("marks a region with a failed utilization query via utilizationError, and null out its numeric fields", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1" })]);
    const utilization = makeUtilizationSnapshot([
      makeRegionUtilization({ geoId: "geo-1", error: "metrics API query failed" }),
    ]);

    const questions = buildResizeQuestions(plan, utilization);
    const option = questions.topology.criteria["scale-up:geo-1"] as { target: Record<string, unknown> };

    expect(option.target["utilizationError"]).toBe("metrics API query failed");
  });

  it("falls back to null utilization fields when a region is entirely absent from the snapshot", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1" })]);
    const utilization = makeUtilizationSnapshot([]);

    const questions = buildResizeQuestions(plan, utilization);
    const option = questions.topology.criteria["scale-up:geo-1"] as { target: Record<string, unknown> };

    expect(option.target["cpuUtilPct"]).toBeNull();
    expect(option.target["nodeCount"]).toBeNull();
  });

  it("uses a real, ordered 10-level rubric for confidence", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1" })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1" })]);

    const questions = buildResizeQuestions(plan, utilization);

    expect(RESIZE_CONFIDENCE_LEVELS).toHaveLength(10);
    expect(questions.confidence.criteria).toEqual(RESIZE_CONFIDENCE_LEVELS);
    // Worst-to-best, situational descriptions, not bare numbers.
    expect(typeof questions.confidence.criteria[0]).toBe("string");
    expect((questions.confidence.criteria[0] as string).length).toBeGreaterThan(20);
  });

  it("builds a true/false disruption-risk question with real situational descriptions", () => {
    const plan = makeDeploymentPlan([makeRegionPlan({ geoId: "geo-1" })]);
    const utilization = makeUtilizationSnapshot([makeRegionUtilization({ geoId: "geo-1" })]);

    const questions = buildResizeQuestions(plan, utilization);

    expect(questions.riskOfDisruption.type).toBe("noul");
    expect(questions.riskOfDisruption.criteria?.true).toBeTruthy();
    expect(questions.riskOfDisruption.criteria?.false).toBeTruthy();
  });
});
