import { describe, expect, it } from "vitest";
import {
  ARCH_CONSISTENCY_LEVELS,
  buildStageAQuestions,
  buildStageBQuestions,
  candidateId,
  COVERAGE_LEVELS,
  COST_LEVELS,
  MATURITY_LEVELS,
  shortlistCandidates,
  SPRAWL_LEVELS,
} from "./questions.js";
import { makeCandidate } from "./test-helpers.js";

describe("candidateId", () => {
  it("joins provider and region with a colon", () => {
    expect(candidateId({ provider: "aws", region: "us-east-1" })).toBe("aws:us-east-1");
  });
});

describe("score level rubrics", () => {
  it("every rubric has exactly 10 ordered levels (0-9)", () => {
    for (const levels of [COVERAGE_LEVELS, COST_LEVELS, MATURITY_LEVELS, SPRAWL_LEVELS, ARCH_CONSISTENCY_LEVELS]) {
      expect(levels.length).toBe(10);
      for (const level of levels) {
        expect(typeof level).toBe("string");
        expect(level.length).toBeGreaterThan(10);
      }
    }
  });

  it("rubrics describe distinct situations, not repeated/degree-only text", () => {
    for (const levels of [COVERAGE_LEVELS, COST_LEVELS, MATURITY_LEVELS, SPRAWL_LEVELS, ARCH_CONSISTENCY_LEVELS]) {
      expect(new Set(levels).size).toBe(levels.length);
    }
  });
});

describe("shortlistCandidates", () => {
  it("hard-caps at 40 total, well under the choice() 255 limit", () => {
    const candidates = Array.from({ length: 100 }, (_, i) =>
      makeCandidate({ provider: "aws", region: `region-${i}`, monthlyUsd: i }),
    );
    const shortlisted = shortlistCandidates(candidates);
    expect(shortlisted.length).toBeLessThanOrEqual(40);
  });

  it("keeps the cheapest candidates per provider, not just globally cheapest", () => {
    // 90 cheap aws candidates + 3 pricier gcp candidates: naive global top-40
    // by price would exclude gcp entirely. The per-provider rule must not.
    const aws = Array.from({ length: 90 }, (_, i) => makeCandidate({ provider: "aws", region: `aws-${i}`, monthlyUsd: i }));
    const gcp = [
      makeCandidate({ provider: "gcp", region: "gcp-a", monthlyUsd: 1000 }),
      makeCandidate({ provider: "gcp", region: "gcp-b", monthlyUsd: 1001 }),
      makeCandidate({ provider: "gcp", region: "gcp-c", monthlyUsd: 1002 }),
    ];

    const shortlisted = shortlistCandidates([...aws, ...gcp], 40);
    const providers = new Set(shortlisted.map((c) => c.provider));
    expect(providers.has("gcp")).toBe(true);
    expect(providers.has("aws")).toBe(true);
  });

  it("returns everything, sorted by cost, when under the cap", () => {
    const candidates = [
      makeCandidate({ provider: "aws", region: "a", monthlyUsd: 300 }),
      makeCandidate({ provider: "azure", region: "b", monthlyUsd: 100 }),
      makeCandidate({ provider: "gcp", region: "c", monthlyUsd: 200 }),
    ];
    const shortlisted = shortlistCandidates(candidates);
    expect(shortlisted).toHaveLength(3);
    expect(shortlisted.map((c) => c.monthlyUsd)).toEqual([100, 200, 300]);
  });
});

describe("buildStageAQuestions", () => {
  it("builds a choice() selection/fallback over shortlisted candidate ids, and score()/noul() for the rest", () => {
    const candidates = [
      makeCandidate({ provider: "aws", region: "us-east-1", monthlyUsd: 100 }),
      makeCandidate({ provider: "azure", region: "westeurope", monthlyUsd: 150 }),
    ];
    const questions = buildStageAQuestions(candidates);

    expect(questions.selection.type).toBe("choice");
    expect(Object.keys(questions.selection.criteria).sort()).toEqual(["aws:us-east-1", "azure:westeurope"]);
    expect(questions.fallback.type).toBe("choice");

    expect(questions.coverage.type).toBe("score");
    expect(questions.coverage.criteria).toHaveLength(10);
    expect(questions.costFit.type).toBe("score");
    expect(questions.maturity.type).toBe("score");
    expect(questions.sprawlRisk.type).toBe("score");
    expect(questions.archConsistency.type).toBe("score");
    expect(questions.archConsistency.criteria).toHaveLength(10);

    expect(questions.residencyOk.type).toBe("noul");
    expect(questions.capacityOk.type).toBe("noul");
  });
});

describe("buildStageBQuestions", () => {
  it("builds choice() questions for ingress, autoscaling, and sizing only", () => {
    const questions = buildStageBQuestions();
    expect(Object.keys(questions).sort()).toEqual(["autoscaling", "ingress", "sizing"]);
    expect(questions.ingress.type).toBe("choice");
    expect(questions.autoscaling.type).toBe("choice");
    expect(questions.sizing.type).toBe("choice");
  });
});
