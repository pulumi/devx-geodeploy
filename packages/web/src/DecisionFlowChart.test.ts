import { describe, expect, it } from "vitest";
import { buildFlowStages, describeAnswer, describeQuestion } from "./DecisionFlowChart";
import type { DecisionRecord } from "./types";

describe("describeQuestion", () => {
  it("extracts prompt and criteria from a real choice() question shape", () => {
    const question = {
      type: "choice",
      instructions: "Which candidate region should serve this demand geo?",
      criteria: {
        "aws:us-east-1": { provider: "aws", region: "us-east-1", monthlyUsd: 120 },
        "aws:eu-west-1": { provider: "aws", region: "eu-west-1", monthlyUsd: 140 },
      },
    };
    const described = describeQuestion(question);
    expect(described.kind).toBe("choice");
    expect(described.prompt).toBe("Which candidate region should serve this demand geo?");
    expect(described.criteriaEntries).toHaveLength(2);
    expect(described.criteriaEntries[0]![0]).toBe("aws:us-east-1");
  });

  it("extracts prompt and ordered criteria from a real score() question shape", () => {
    const question = {
      type: "score",
      instructions: "How well does the selected region cover this demand geo's users?",
      criteria: ["worst situation", "middling situation", "best situation"],
    };
    const described = describeQuestion(question);
    expect(described.kind).toBe("score");
    expect(described.criteriaEntries).toEqual([
      ["0", "worst situation"],
      ["1", "middling situation"],
      ["2", "best situation"],
    ]);
  });

  it("extracts prompt and true/false criteria from a real noul() question shape", () => {
    const question = {
      type: "noul",
      instructions: "Does the selected region satisfy the stated data-residency constraint?",
      criteria: { true: "fully satisfies residency", false: "does not satisfy residency" },
    };
    const described = describeQuestion(question);
    expect(described.kind).toBe("noul");
    expect(described.criteriaEntries).toEqual([
      ["true", "fully satisfies residency"],
      ["false", "does not satisfy residency"],
    ]);
  });

  it("degrades gracefully for a malformed or missing-field question", () => {
    expect(describeQuestion(null).kind).toBe("unknown");
    expect(describeQuestion(undefined).kind).toBe("unknown");
    expect(describeQuestion({ type: "choice" }).kind).toBe("unknown");
    expect(describeQuestion("not an object").kind).toBe("unknown");
  });
});

describe("describeAnswer", () => {
  it("formats a real ChoiceResponse", () => {
    const described = describeAnswer({ type: "choice", choice: "aws:eu-west-1", confidence: 0.82, probabilities: {} });
    expect(described.kind).toBe("choice");
    expect(described.summary).toBe("choice=aws:eu-west-1 (confidence 0.82)");
    expect(described.confidence).toBe(0.82);
  });

  it("formats a real ScoreResponse and looks up the matched legend entry", () => {
    const described = describeAnswer({
      type: "score",
      score: 8.2,
      confidence: 0.9,
      legend: { "8": "an established, GA, multi-AZ region" },
    });
    expect(described.kind).toBe("score");
    expect(described.summary).toBe("score=8.20 (confidence 0.90)");
    expect(described.matchedCriterion).toBe("an established, GA, multi-AZ region");
  });

  it("formats a real NoulResponse", () => {
    const described = describeAnswer({ type: "noul", noul: 0.97 });
    expect(described.kind).toBe("noul");
    expect(described.summary).toBe("noul=0.97");
  });

  it("falls back to raw JSON for an unrecognized shape", () => {
    const described = describeAnswer({ weird: true });
    expect(described.kind).toBe("unknown");
    expect(described.summary).toBe(JSON.stringify({ weird: true }));
  });
});

function stageARecord(): DecisionRecord {
  return {
    geoId: "eu-west",
    kind: "geo-selection",
    mode: "typesafe",
    questions: {
      selection: {
        type: "choice",
        instructions: "Which candidate region should serve this demand geo?",
        criteria: { "aws:eu-west-1": { provider: "aws", region: "eu-west-1" } },
      },
      residencyOk: {
        type: "noul",
        instructions: "Does the selected region satisfy residency?",
        criteria: { true: "yes", false: "no" },
      },
    },
    answers: {
      selection: { type: "choice", choice: "aws:eu-west-1", confidence: 0.9, probabilities: {} },
      residencyOk: { type: "noul", noul: 0.99 },
    },
    selection: { provider: "aws", region: "eu-west-1" },
    gates: {
      residencyOk: { value: 0.99, threshold: 0.95, passed: true },
    },
    composite: 0.87,
    reason: "Chosen for low cost and strong coverage.",
  };
}

function stageBRecord(): DecisionRecord {
  return {
    geoId: "eu-west",
    kind: "geo-selection",
    mode: "typesafe",
    questions: {
      ingress: {
        type: "choice",
        instructions: "Which ingress posture should front this workload?",
        criteria: { "ingress.public-alb": "standard public ALB" },
      },
    },
    answers: {
      ingress: { type: "choice", choice: "ingress.public-alb", confidence: 0.95, probabilities: {} },
    },
    selection: { provider: "aws", region: "eu-west-1" },
    gates: {
      moduleSelection: { value: 0.95, threshold: 0.85, passed: true },
    },
    reason: "Public ALB is sufficient for this workload.",
  };
}

function fallbackRecord(): DecisionRecord {
  return {
    geoId: "sa-east",
    kind: "geo-selection",
    mode: "deterministic-fallback",
    selection: { provider: "aws", region: "sa-east-1" },
    reason: "TypeSafe was not configured; used deterministic cost-only ranking.",
  };
}

/** A real shape: TypeSafe *was* asked and answered, but a hard gate rejected
 * its own top pick, so the final selection came from deterministic override
 * logic instead -- distinct from `fallbackRecord()`, which never called
 * TypeSafe at all. */
function aiPathAbortedRecord(): DecisionRecord {
  return {
    geoId: "sa-east",
    kind: "geo-selection",
    mode: "deterministic-fallback",
    questions: {
      selection: {
        type: "choice",
        instructions: "Which candidate region should serve this demand geo?",
        criteria: { "aws:sa-east-1": { provider: "aws", region: "sa-east-1" } },
      },
      residencyOk: {
        type: "noul",
        instructions: "Does the selected region satisfy residency?",
        criteria: { true: "yes", false: "no" },
      },
    },
    answers: {
      selection: { type: "choice", choice: "aws:sa-east-1", confidence: 0.7, probabilities: {} },
      residencyOk: { type: "noul", noul: 0.8 },
    },
    selection: { provider: "aws", region: "sa-east-1" },
    reason: "AI path aborted (residencyOk hard gate failed (0.80 < 0.95)); fell back to deterministic ranking.",
  };
}

describe("buildFlowStages", () => {
  it("builds two ordered stages for a 2-stage geo-selection pipeline", () => {
    const stages = buildFlowStages([stageARecord(), stageBRecord()]);
    expect(stages).toHaveLength(2);

    expect(stages[0]!.isFallback).toBe(false);
    expect(stages[0]!.questionNodes.map((n) => n.key)).toEqual(["selection", "residencyOk"]);
    expect(stages[0]!.gateEntries).toEqual([["residencyOk", { value: 0.99, threshold: 0.95, passed: true }]]);
    expect(stages[0]!.outcomeEntries).toEqual([["selection", "aws:eu-west-1"]]);

    expect(stages[1]!.questionNodes.map((n) => n.key)).toEqual(["ingress"]);
    expect(stages[1]!.outcomeEntries).toEqual([
      ["selection", "aws:eu-west-1"],
      ["ingress", "ingress.public-alb (confidence 0.95)"],
    ]);
  });

  it("marks a deterministic-fallback record with no recorded questions as isFallback", () => {
    const stages = buildFlowStages([fallbackRecord()]);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.isFallback).toBe(true);
    expect(stages[0]!.aiPathAborted).toBe(false);
    expect(stages[0]!.questionNodes).toHaveLength(0);
  });

  it("marks a deterministic-fallback record that DID call TypeSafe as aiPathAborted, not isFallback", () => {
    const stages = buildFlowStages([aiPathAbortedRecord()]);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.isFallback).toBe(false);
    expect(stages[0]!.aiPathAborted).toBe(true);
    expect(stages[0]!.questionNodes.map((n) => n.key)).toEqual(["selection", "residencyOk"]);
  });

  it("builds a single stage for a single resize-style record", () => {
    const resizeRecord: DecisionRecord = {
      geoId: "us-east",
      kind: "resize",
      mode: "typesafe",
      questions: {
        action: {
          type: "choice",
          instructions: "What topology action fits this region's observed utilization?",
          criteria: { "no-change": "steady state" },
        },
      },
      answers: {
        action: { type: "choice", choice: "no-change", confidence: 0.88, probabilities: {} },
      },
      selection: { provider: "aws", region: "us-east-1" },
      gates: { resizeTopologySuggest: { value: 0.88, threshold: 0.7, passed: true } },
      reason: "Utilization is within the steady-state band.",
    };
    const stages = buildFlowStages([resizeRecord]);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.isFallback).toBe(false);
    expect(stages[0]!.questionNodes).toHaveLength(1);
  });
});
