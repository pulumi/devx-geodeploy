import type { CSSProperties } from "react";
import { theme } from "./theme";
import type { DecisionRecord } from "./types";

// ---------------------------------------------------------------------------
// Shared decision-record rendering — a direct JSX port of
// packages/cli/src/explainCmd.ts's formatAnswer/explainRecord (same data,
// same branching precedence: score+confidence / noul / choice+confidence /
// raw-JSON fallback), used by both RegionModal (geo-selection records) and
// ResizePanel (resize records) so there's one place to keep in sync with
// explainCmd.ts's own branching if it ever changes.
// ---------------------------------------------------------------------------

export function AnswerRow({ name, answer }: { name: string; answer: unknown }) {
  if (typeof answer !== "object" || answer === null) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{name}</span>
        <span style={monoStyle}>{JSON.stringify(answer)}</span>
      </div>
    );
  }
  const a = answer as Record<string, unknown>;
  const confidence = typeof a["confidence"] === "number" ? (a["confidence"] as number).toFixed(2) : undefined;

  if (typeof a["score"] === "number") {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{name}</span>
        <span style={monoStyle}>
          score={(a["score"] as number).toFixed(2)}
          {confidence ? ` confidence=${confidence}` : ""}
        </span>
      </div>
    );
  }
  if (typeof a["noul"] === "number") {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{name}</span>
        <span style={monoStyle}>noul={(a["noul"] as number).toFixed(2)}</span>
      </div>
    );
  }
  if (typeof a["choice"] === "string") {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{name}</span>
        <span style={monoStyle}>
          choice={a["choice"]}
          {confidence ? ` confidence=${confidence}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{name}</span>
      <span style={monoStyle}>{JSON.stringify(answer)}</span>
    </div>
  );
}

export const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: theme.space.m,
  padding: `${theme.space.xs}px 0`,
  fontSize: 13,
};
export const labelStyle: CSSProperties = { color: theme.color.mutedText };
export const monoStyle: CSSProperties = { color: theme.color.bodyText, fontFamily: theme.font.mono, fontSize: 12 };

export function DecisionRecordView({ record, index }: { record: DecisionRecord; index: number }) {
  return (
    <div
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: 6,
        padding: theme.space.l,
        marginBottom: theme.space.m,
        background: theme.color.surface50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space.m, marginBottom: theme.space.s }}>
        <span style={{ fontSize: 12, color: theme.color.mutedText }}>decision record #{index + 1}</span>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: record.mode === "typesafe" ? theme.color.primary : theme.color.surface100,
            color: record.mode === "typesafe" ? theme.color.bg : theme.color.headingText,
            fontWeight: 600,
          }}
        >
          {record.mode}
        </span>
        {record.composite !== undefined && (
          <span style={{ fontSize: 12, fontFamily: theme.font.mono, color: theme.color.mutedText }}>
            composite: {record.composite.toFixed(3)}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, color: theme.color.mutedText, marginBottom: theme.space.s }}>
        selection: {record.selection.provider}:{record.selection.region}
      </div>

      {record.gates && Object.keys(record.gates).length > 0 && (
        <div style={{ marginBottom: theme.space.s }}>
          <div style={{ fontSize: 12, color: theme.color.headingText, marginBottom: theme.space.xs }}>gates</div>
          {Object.entries(record.gates).map(([name, gate]) => (
            <div key={name} style={rowStyle}>
              <span style={labelStyle}>{name}</span>
              <span style={{ ...monoStyle, color: gate.passed ? theme.color.successText : theme.color.failureText }}>
                {gate.value.toFixed(2)} vs threshold {gate.threshold.toFixed(2)} → {gate.passed ? "PASS" : "FAIL"}
              </span>
            </div>
          ))}
        </div>
      )}

      {record.answers && Object.keys(record.answers).length > 0 && (
        <div style={{ marginBottom: theme.space.s }}>
          <div style={{ fontSize: 12, color: theme.color.headingText, marginBottom: theme.space.xs }}>answers</div>
          {Object.entries(record.answers).map(([name, answer]) => (
            <AnswerRow key={name} name={name} answer={answer} />
          ))}
        </div>
      )}

      <div style={{ fontSize: 13, color: theme.color.bodyText }}>{record.reason}</div>
    </div>
  );
}
