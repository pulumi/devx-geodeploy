import { useEffect } from "react";
import { theme } from "./theme";
import { DecisionRecordView, monoStyle } from "./decisionRendering";
import { DecisionFlowChart } from "./DecisionFlowChart";
import { isApplyStale } from "./pointColor";
import type { ApplyRecord, DeploymentPlan, RegionPlan } from "./types";

export interface RegionModalProps {
  plan: DeploymentPlan;
  region: RegionPlan;
  apply: ApplyRecord | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Pulumi State section — four mutually exclusive real states.
// ---------------------------------------------------------------------------

function PulumiState({
  region,
  apply,
  planRequestId,
}: {
  region: RegionPlan;
  apply: ApplyRecord | null;
  planRequestId: string;
}) {
  if (apply === null) {
    return (
      <div style={{ color: theme.color.infoText, fontSize: 13 }}>
        Not yet provisioned — run <code style={monoStyle}>geodeploy apply</code>.
      </div>
    );
  }

  // An apply record only ever reflects the plan it was actually run against
  // (apply.json is never cleared when a newer plan.json supersedes it) — a
  // stale record for a since-superseded plan revision is not a current
  // result for this plan, even if this geoId happens to also exist in it.
  if (isApplyStale(apply, planRequestId)) {
    return (
      <div style={{ color: theme.color.infoText, fontSize: 13 }}>
        Not yet provisioned under the current plan — a previous apply exists for an older plan revision. Run{" "}
        <code style={monoStyle}>geodeploy apply</code> to provision this plan.
      </div>
    );
  }

  if (apply.refused) {
    return (
      <div style={{ borderLeft: `3px solid ${theme.color.warningBadge}`, paddingLeft: theme.space.l }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space.s, marginBottom: theme.space.s }}>
          <span style={{ color: theme.color.warningBadge, fontWeight: 600 }}>&#9888;</span>
          <span style={{ color: theme.color.headingText, fontSize: 13, fontWeight: 600 }}>Apply refused</span>
        </div>
        <ul style={{ margin: 0, paddingLeft: theme.space.xl, color: theme.color.bodyText, fontSize: 13 }}>
          {apply.blockers.map((blocker, i) => (
            <li key={i}>{blocker}</li>
          ))}
        </ul>
      </div>
    );
  }

  const result = apply.results?.[region.geoId];

  if (result?.status === "failed") {
    return (
      <div style={{ borderLeft: `3px solid ${theme.color.failureBadge}`, paddingLeft: theme.space.l }}>
        <div style={{ color: theme.color.failureText, fontSize: 13, fontWeight: 600, marginBottom: theme.space.s }}>
          Provisioning failed
        </div>
        <pre
          style={{
            margin: 0,
            padding: theme.space.m,
            background: theme.color.surface50,
            border: `1px solid ${theme.color.border}`,
            borderRadius: 6,
            color: theme.color.failureText,
            fontFamily: theme.font.mono,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {result.error ?? "(no error message recorded)"}
        </pre>
      </div>
    );
  }

  if (result?.status === "succeeded") {
    const outputs = Object.entries(result.outputs ?? {});
    return (
      <div>
        <div style={{ color: theme.color.successText, fontSize: 13, fontWeight: 600, marginBottom: theme.space.s }}>
          Provisioned successfully
        </div>
        {outputs.length === 0 ? (
          <div style={{ color: theme.color.mutedText, fontSize: 13 }}>(no outputs recorded)</div>
        ) : (
          <div
            style={{
              background: theme.color.surface50,
              border: `1px solid ${theme.color.border}`,
              borderRadius: 6,
              padding: theme.space.m,
              fontFamily: theme.font.mono,
              fontSize: 12,
            }}
          >
            {outputs.map(([key, value]) => (
              <div key={key} style={{ display: "flex", gap: theme.space.m, padding: `${theme.space.xs}px 0` }}>
                <span style={{ color: theme.color.mutedText, minWidth: 160 }}>{key}</span>
                <span style={{ color: theme.color.bodyText, wordBreak: "break-all" }}>
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Refused === false and no per-region result: apply ran but this region has
  // no recorded outcome yet — treat the same as "not yet provisioned".
  return (
    <div style={{ color: theme.color.infoText, fontSize: 13 }}>
      Not yet provisioned — run <code style={monoStyle}>geodeploy apply</code>.
    </div>
  );
}

export function RegionModal({ plan, region, apply, onClose }: RegionModalProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Resize decisions (kind: "resize") are shown in ResizePanel, not here —
  // this modal is specifically about how the region was originally selected.
  const records = plan.decisionRecords.filter((r) => r.geoId === region.geoId && r.kind !== "resize");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: theme.dialogWidth.medium,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          overflowY: "auto",
          background: theme.color.surface50,
          border: `1px solid ${theme.color.border}`,
          borderRadius: 10,
          color: theme.color.bodyText,
          fontFamily: theme.font.sans,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            padding: theme.space.xl,
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: theme.font.display, color: theme.color.primary }}>
              {region.geoId}
            </div>
            <div style={{ fontSize: 13, color: theme.color.mutedText, marginTop: theme.space.xs }}>
              {region.provider}:{region.region} · {region.sku} · {region.nodesNeeded} node
              {region.nodesNeeded === 1 ? "" : "s"} · ${region.monthlyUsd.toFixed(2)}/mo
            </div>
            <div style={{ marginTop: theme.space.s }}>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: region.provisionable ? theme.color.successBadge : theme.color.warningBadge,
                  color: theme.color.bg,
                  fontWeight: 600,
                }}
              >
                {region.provisionable ? "provisionable" : "not provisionable"}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: theme.color.mutedText,
              fontSize: 20,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        <div style={{ padding: theme.space.xl }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              fontFamily: theme.font.display,
              color: theme.color.primary,
              marginBottom: theme.space.m,
            }}
          >
            Decision
          </div>
          <DecisionFlowChart records={records} />
          {records.length === 0 ? (
            <div style={{ color: theme.color.mutedText, fontSize: 13, marginBottom: theme.space.xl }}>
              (no decision record found)
            </div>
          ) : (
            <div style={{ marginBottom: theme.space.xl }}>
              {records.map((record, i) => (
                <DecisionRecordView key={i} record={record} index={i} />
              ))}
            </div>
          )}

          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              fontFamily: theme.font.display,
              color: theme.color.primary,
              marginBottom: theme.space.m,
            }}
          >
            Pulumi State
          </div>
          <PulumiState region={region} apply={apply} planRequestId={plan.requestId} />
        </div>
      </div>
    </div>
  );
}
