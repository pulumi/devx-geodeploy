import { useState, type CSSProperties } from "react";
import { theme } from "./theme";
import type { ConfidenceGate, DecisionRecord } from "./types";

// ---------------------------------------------------------------------------
// A "systems flow chart" view of the TypeSafe AI pipeline behind a
// DecisionRecord[]: input -> parallel questions (prompt + answer) -> gate
// checks -> outcome, one stage per record, stages connected top-to-bottom so
// a 2-stage geo-selection pipeline (Stage A candidate selection -> Stage B
// module selection) visibly reads as one pipeline. Purely additive: rendered
// above the existing DecisionRecordView list in both RegionModal and
// ResizePanel, which is unchanged.
//
// Every question/answer here comes straight from @typesafe-ai/sdk's own
// question/response shapes (choice()/score()/noul(), see
// packages/decide/src/questions.ts) as recorded verbatim on the
// DecisionRecord (`questions`/`answers`, both z.unknown() at the schema
// level) -- these helpers defensively re-derive the real shape rather than
// trusting a type assertion, since a future TypeSafe SDK version or an older
// plan.json on disk could carry a shape these helpers don't recognize.
// ---------------------------------------------------------------------------

export type QuestionKind = "choice" | "score" | "noul" | "unknown";

export interface DescribedQuestion {
  kind: QuestionKind;
  /** The literal prompt text asked of TypeSafe (a Question's `instructions`). */
  prompt: string;
  /** The full rubric/options list, normalized to label/description pairs. */
  criteriaEntries: [string, string][];
}

function stringifyEntryType(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Same as `stringifyEntryType`, but pretty-prints objects/arrays (indented,
 * multi-line) rather than one dense compact line -- used only for criteria
 * descriptions, which can be full candidate-cost objects, never for prompt
 * text (which is always shown inline). */
function stringifyEntryTypePretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

export function describeQuestion(question: unknown): DescribedQuestion {
  if (typeof question !== "object" || question === null) {
    return { kind: "unknown", prompt: stringifyEntryType(question), criteriaEntries: [] };
  }
  const q = question as Record<string, unknown>;
  const prompt = stringifyEntryType(q["instructions"]);

  if (q["type"] === "choice" && typeof q["criteria"] === "object" && q["criteria"] !== null) {
    const criteria = q["criteria"] as Record<string, unknown>;
    return {
      kind: "choice",
      prompt,
      criteriaEntries: Object.entries(criteria).map(([label, desc]) => [label, stringifyEntryTypePretty(desc)]),
    };
  }
  if (q["type"] === "score" && Array.isArray(q["criteria"])) {
    return {
      kind: "score",
      prompt,
      criteriaEntries: (q["criteria"] as unknown[]).map((desc, i) => [String(i), stringifyEntryTypePretty(desc)]),
    };
  }
  if (q["type"] === "noul") {
    const criteria = (q["criteria"] as Record<string, unknown> | null | undefined) ?? {};
    const entries: [string, string][] = [];
    if ("true" in criteria) entries.push(["true", stringifyEntryType(criteria["true"])]);
    if ("false" in criteria) entries.push(["false", stringifyEntryType(criteria["false"])]);
    return { kind: "noul", prompt, criteriaEntries: entries };
  }
  return { kind: "unknown", prompt: prompt || JSON.stringify(question), criteriaEntries: [] };
}

export interface DescribedAnswer {
  kind: QuestionKind;
  /** A short human-readable summary, e.g. "choice=aws:eu-west-1 (confidence 0.82)". */
  summary: string;
  confidence?: number;
  /** For score answers, the rubric text the score landed nearest to, if the legend was recorded. */
  matchedCriterion?: string;
}

export function describeAnswer(answer: unknown): DescribedAnswer {
  if (typeof answer !== "object" || answer === null) {
    return { kind: "unknown", summary: JSON.stringify(answer) };
  }
  const a = answer as Record<string, unknown>;
  const confidence = typeof a["confidence"] === "number" ? (a["confidence"] as number) : undefined;

  if (typeof a["score"] === "number") {
    const score = a["score"] as number;
    const legend = a["legend"] as Record<string, unknown> | undefined;
    const matchedCriterion = legend ? stringifyEntryType(legend[String(Math.round(score))]) : undefined;
    return {
      kind: "score",
      summary: `score=${score.toFixed(2)}${confidence !== undefined ? ` (confidence ${confidence.toFixed(2)})` : ""}`,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(matchedCriterion ? { matchedCriterion } : {}),
    };
  }
  if (typeof a["noul"] === "number") {
    return { kind: "noul", summary: `noul=${(a["noul"] as number).toFixed(2)}` };
  }
  if (typeof a["choice"] === "string") {
    return {
      kind: "choice",
      summary: `choice=${a["choice"]}${confidence !== undefined ? ` (confidence ${confidence.toFixed(2)})` : ""}`,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  return { kind: "unknown", summary: JSON.stringify(answer) };
}

export interface FlowQuestionNode {
  key: string;
  question: DescribedQuestion;
  answer: DescribedAnswer;
}

export interface FlowStage {
  record: DecisionRecord;
  /** No TypeSafe call happened at all for this stage (e.g. no API key configured) -- `questions` is empty. */
  isFallback: boolean;
  /**
   * TypeSafe *was* asked and answered (real `questions`/`answers` present),
   * but a hard gate rejected its own top answer, so the final `selection`
   * came from deterministic override logic instead -- a real, common shape
   * (`mode: "deterministic-fallback"` with non-empty `questions`), distinct
   * from `isFallback` (no call at all). The question/answer fan-out is still
   * the real, valuable thing to show here; only the outcome styling differs.
   */
  aiPathAborted: boolean;
  questionNodes: FlowQuestionNode[];
  gateEntries: [string, ConfidenceGate][];
  /** Every choice-type answer's chosen value, plus the record's own selection -- the stage's real output. */
  outcomeEntries: [string, string][];
}

export function buildFlowStages(records: DecisionRecord[]): FlowStage[] {
  return records.map((record) => {
    const questionKeys = Object.keys(record.questions ?? {});
    const isFallback = questionKeys.length === 0;
    const aiPathAborted = !isFallback && record.mode === "deterministic-fallback";

    const questionNodes: FlowQuestionNode[] = questionKeys.map((key) => ({
      key,
      question: describeQuestion(record.questions?.[key]),
      answer: describeAnswer(record.answers?.[key]),
    }));

    const gateEntries = Object.entries(record.gates ?? {});

    // Every choice answer is a real chosen value this stage produced, except
    // "selection" itself -- that's the same geo pick already carried on
    // `record.selection` (added once below), not a second distinct output.
    const outcomeEntries: [string, string][] = questionNodes
      .filter((n) => n.answer.kind === "choice" && n.key !== "selection")
      .map((n) => [n.key, n.answer.summary.replace(/^choice=/, "")]);
    outcomeEntries.unshift(["selection", `${record.selection.provider}:${record.selection.region}`]);

    return { record, isFallback, aiPathAborted, questionNodes, gateEntries, outcomeEntries };
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const KIND_COLOR: Record<QuestionKind, string> = {
  choice: theme.color.primary,
  score: theme.color.accent,
  noul: theme.color.selectionHighlight,
  unknown: theme.color.mutedText,
};

const boxStyle: CSSProperties = {
  border: `1px solid ${theme.color.border}`,
  borderRadius: 6,
  background: theme.color.surface50,
  padding: theme.space.m,
};

function Connector() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: 2, height: theme.space.l, background: theme.color.border }} />
      <div
        style={{
          width: 0,
          height: 0,
          borderStyle: "solid",
          borderWidth: "7px 5px 0 5px",
          borderColor: `${theme.color.border} transparent transparent transparent`,
        }}
      />
    </div>
  );
}

function KindBadge({ kind }: { kind: QuestionKind }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "1px 6px",
        borderRadius: 999,
        color: theme.color.bg,
        background: KIND_COLOR[kind],
      }}
    >
      {kind}
    </span>
  );
}

function QuestionNode({ node }: { node: FlowQuestionNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      style={{
        ...boxStyle,
        width: 220,
        cursor: "pointer",
        borderTop: `3px solid ${KIND_COLOR[node.question.kind]}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: theme.space.xs }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.color.headingText }}>{node.key}</span>
        <KindBadge kind={node.question.kind} />
      </div>
      <div style={{ fontSize: 12, color: theme.color.bodyText, marginBottom: theme.space.xs }}>{node.question.prompt}</div>
      <div style={{ fontSize: 12, fontFamily: theme.font.mono, color: theme.color.mutedText }}>{node.answer.summary}</div>
      {node.answer.matchedCriterion && (
        <div style={{ fontSize: 11, color: theme.color.mutedText, marginTop: theme.space.xs, fontStyle: "italic" }}>
          &rarr; {node.answer.matchedCriterion}
        </div>
      )}
      {expanded && node.question.criteriaEntries.length > 0 && (
        <div
          style={{
            marginTop: theme.space.s,
            paddingTop: theme.space.s,
            borderTop: `1px solid ${theme.color.border}`,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <div style={{ fontSize: 10, color: theme.color.mutedText, marginBottom: theme.space.xs }}>
            full criteria ({node.question.criteriaEntries.length})
          </div>
          {node.question.criteriaEntries.map(([label, desc]) => (
            <div key={label} style={{ fontSize: 11, marginBottom: theme.space.xs }}>
              <div style={{ fontFamily: theme.font.mono, color: theme.color.headingText }}>{label}</div>
              <div
                style={{
                  color: theme.color.mutedText,
                  fontFamily: theme.font.mono,
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {desc}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: theme.color.mutedText, marginTop: theme.space.xs }}>
        {expanded ? "click to collapse" : "click to expand"}
      </div>
    </div>
  );
}

function GateDiamond({ name, gate }: { name: string; gate: ConfidenceGate }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 120 }}>
      <div
        style={{
          width: 84,
          height: 84,
          clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
          background: gate.passed ? theme.color.successBadge : theme.color.failureBadge,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: 9, color: theme.color.bg, padding: 4, lineHeight: 1.2 }}>
          {gate.value.toFixed(2)}/{gate.threshold.toFixed(2)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: theme.color.mutedText, marginTop: theme.space.xs, textAlign: "center" }}>
        {name}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: gate.passed ? theme.color.successText : theme.color.failureText,
        }}
      >
        {gate.passed ? "PASS" : "FAIL"}
      </div>
    </div>
  );
}

function StageChart({ stage, index }: { stage: FlowStage; index: number }) {
  const { record } = stage;
  return (
    <div>
      <div
        style={{
          ...boxStyle,
          display: "inline-flex",
          alignItems: "center",
          gap: theme.space.s,
        }}
      >
        <span style={{ fontSize: 12, color: theme.color.mutedText }}>stage {index + 1}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.headingText }}>{record.geoId}</span>
        <span style={{ fontSize: 11, color: theme.color.mutedText }}>{record.kind}</span>
        <span
          style={{
            fontSize: 10,
            padding: "1px 8px",
            borderRadius: 999,
            background: record.mode === "typesafe" ? theme.color.primary : theme.color.surface100,
            color: record.mode === "typesafe" ? theme.color.bg : theme.color.headingText,
            fontWeight: 600,
          }}
        >
          {record.mode}
        </span>
      </div>

      {stage.isFallback ? (
        <>
          <Connector />
          <div style={{ ...boxStyle, borderLeft: `3px solid ${theme.color.warningBadge}`, maxWidth: 460 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.color.warningText, marginBottom: theme.space.xs }}>
              Deterministic fallback — TypeSafe was never asked
            </div>
            <div style={{ fontSize: 12, color: theme.color.bodyText }}>{record.reason}</div>
          </div>
        </>
      ) : (
        <>
          <Connector />
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space.m }}>
            {stage.questionNodes.map((node) => (
              <QuestionNode key={node.key} node={node} />
            ))}
          </div>

          {stage.gateEntries.length > 0 && (
            <>
              <Connector />
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space.l, alignItems: "flex-start" }}>
                {stage.gateEntries.map(([name, gate]) => (
                  <GateDiamond key={name} name={name} gate={gate} />
                ))}
                {record.composite !== undefined && (
                  <div style={{ fontSize: 12, fontFamily: theme.font.mono, color: theme.color.mutedText, alignSelf: "center" }}>
                    composite: {record.composite.toFixed(3)}
                  </div>
                )}
              </div>
            </>
          )}

          <Connector />
          <div
            style={{
              ...boxStyle,
              display: "inline-block",
              border: `2px solid ${stage.aiPathAborted ? theme.color.warningBadge : theme.color.accent}`,
              maxWidth: 460,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: stage.aiPathAborted ? theme.color.warningText : theme.color.accent,
                marginBottom: theme.space.xs,
              }}
            >
              {stage.aiPathAborted ? "Outcome — deterministic override (AI answer rejected)" : "Outcome"}
            </div>
            {stage.outcomeEntries.map(([key, value]) => (
              <div key={key} style={{ fontSize: 12, fontFamily: theme.font.mono, color: theme.color.bodyText }}>
                {key}: {value}
              </div>
            ))}
            {stage.aiPathAborted && (
              <div style={{ fontSize: 11, color: theme.color.mutedText, marginTop: theme.space.xs }}>
                {record.reason}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function DecisionFlowChart({ records }: { records: DecisionRecord[] }) {
  const stages = buildFlowStages(records);
  if (stages.length === 0) return null;

  return (
    <div
      style={{
        marginBottom: theme.space.xl,
        padding: theme.space.l,
        border: `1px solid ${theme.color.border}`,
        borderRadius: 8,
        background: theme.color.surface100,
        overflowX: "auto",
      }}
    >
      {stages.map((stage, i) => (
        <div key={i}>
          <StageChart stage={stage} index={i} />
          {i < stages.length - 1 && <Connector />}
        </div>
      ))}
    </div>
  );
}
