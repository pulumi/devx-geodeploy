import { useEffect, useState } from "react";
import { theme } from "./theme";
import { DecisionRecordView, monoStyle } from "./decisionRendering";
import { DecisionFlowChart } from "./DecisionFlowChart";
import { ditheredModalBackdropCss } from "./modalBackdrop";
import type { DeploymentPlan, MonitorRecord, RegionResizeAction, RegionUtilization } from "./types";

export interface ResizePanelProps {
  monitor: MonitorRecord;
  /** The currently-loaded plan, used only to detect a stale monitor (see the staleness banner below); `null`/omitted skips the check. */
  plan?: DeploymentPlan | null;
  onClose: () => void;
}

const ACTION_LABEL: Record<RegionResizeAction["action"], string> = {
  "no-change": "No change",
  "scale-up": "Scale up",
  "scale-down": "Scale down",
  "shift-out": "Shift out",
  "shift-in": "Shift in",
};

const ACTION_COLOR: Record<RegionResizeAction["action"], string> = {
  "no-change": theme.color.mutedText,
  "scale-up": theme.color.successText,
  "scale-down": theme.color.warningText,
  "shift-out": theme.color.infoText,
  "shift-in": theme.color.infoText,
};

function UtilizationRow({ util }: { util: RegionUtilization }) {
  if (util.error) {
    return (
      <div style={{ ...rowStyle, color: theme.color.failureText }}>
        <span style={{ fontWeight: 600 }}>{util.geoId}</span>
        <span style={monoStyle}>error: {util.error}</span>
      </div>
    );
  }
  return (
    <div style={rowStyle}>
      <span style={{ fontWeight: 600, color: theme.color.headingText }}>{util.geoId}</span>
      <span style={monoStyle}>
        {(util.cpuUtilPct * 100).toFixed(0)}% cpu · {util.nodeCount} node{util.nodeCount === 1 ? "" : "s"} ·{" "}
        {util.podCount} pod{util.podCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function ActionRow({ action }: { action: RegionResizeAction }) {
  return (
    <div style={rowStyle}>
      <span style={{ fontWeight: 600, color: theme.color.headingText }}>{action.geoId}</span>
      <span style={{ color: ACTION_COLOR[action.action], fontWeight: 600 }}>
        {ACTION_LABEL[action.action]}
        {action.newNodesNeeded !== undefined ? ` → ${action.newNodesNeeded} nodes` : ""}
        {action.pairedGeoId ? ` (${action.action === "shift-out" ? "to" : "from"} ${action.pairedGeoId})` : ""}
      </span>
    </div>
  );
}

const rowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: theme.space.m,
  padding: `${theme.space.xs}px 0`,
  fontSize: 13,
} as const;

type MonitorMode = MonitorRecord["mode"];

export function ResizePanel({ monitor, plan, onClose }: ResizePanelProps) {
  // Same class of bug as apply.json vs plan.json (see pointColor.ts's
  // isApplyStale): monitor.json is written by a long-running `geodeploy
  // monitor` process against whichever plan.json it was started with, and
  // nothing stops that plan from being superseded by a newer wizard
  // submission while the monitor keeps running against the old one.
  const monitorIsStale = plan != null && monitor.requestId !== plan.requestId;

  const [applyState, setApplyState] = useState<"idle" | "applying" | "error">("idle");
  const [applyError, setApplyError] = useState<string | null>(null);

  // `monitor`/`ui` are separate processes (see monitorCmd.ts's
  // writeMonitorModeControl doc comment) — a mode-change request only takes
  // effect on the monitor loop's *next* poll, so `monitor.mode` itself lags
  // a click by up to one poll interval. `pendingMode` covers that gap in the
  // UI; it's cleared the moment the real `monitor.mode` catches up.
  const [pendingMode, setPendingMode] = useState<MonitorMode | null>(null);
  const [modeChangeError, setModeChangeError] = useState<string | null>(null);
  useEffect(() => {
    if (pendingMode === monitor.mode) setPendingMode(null);
  }, [monitor.mode, pendingMode]);
  const displayedMode = pendingMode ?? monitor.mode;

  async function handleSetMode(mode: MonitorMode) {
    if (mode === displayedMode) return;
    setModeChangeError(null);
    try {
      const res = await fetch("/api/monitor/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? "request failed");
      setPendingMode(mode);
    } catch (err) {
      setModeChangeError(err instanceof Error ? err.message : String(err));
    }
  }

  const resize = monitor.lastResize;
  // Only ever offered in approval-gated mode: autonomous mode already applies
  // eligible resizes on its own (see packages/cli/src/monitorCmd.ts), so a
  // manual button here would either be redundant or, worse, imply a human
  // can second-guess a decision the loop already acted on.
  const canApply = monitor.mode === "approval-gated" && resize !== undefined && !resize.applied && resize.confidencePassed;

  async function handleApply() {
    setApplyState("applying");
    setApplyError(null);
    try {
      const res = await fetch("/api/resize/apply", { method: "POST" });
      const body = (await res.json()) as { error?: string; refused?: boolean; blockers?: string[] };
      if (!res.ok || body.error) {
        throw new Error(body.error ?? "request failed");
      }
      if (body.refused) {
        throw new Error(`refused: ${(body.blockers ?? []).join("; ") || "not ready to provision"}`);
      }
      // The server just rewrote plan.json/monitor.json/apply.json — the
      // existing SSE watcher picks those up and pushes fresh state on its
      // own, so there's nothing further to update locally here.
      setApplyState("idle");
    } catch (err) {
      setApplyState("error");
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: ditheredModalBackdropCss(),
        backgroundSize: "220px 220px",
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
              Resize monitor
            </div>
            <div style={{ fontSize: 13, color: theme.color.mutedText, marginTop: theme.space.xs }}>
              every {(monitor.pollIntervalMs / 1000).toFixed(0)}s ·{" "}
              {monitor.lastPolledAt ? `last polled ${new Date(monitor.lastPolledAt).toLocaleTimeString()}` : "not yet polled"}
            </div>
            <div style={{ marginTop: theme.space.s }}>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: monitor.status === "error" ? theme.color.failureBadge : theme.color.successBadge,
                  color: theme.color.bg,
                  fontWeight: 600,
                }}
              >
                {monitor.status}
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

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.space.m,
            padding: `${theme.space.l}px ${theme.space.xl}px`,
            borderBottom: `1px solid ${theme.color.border}`,
            background: displayedMode === "autonomous" ? theme.color.accent : theme.color.surface100,
            color: displayedMode === "autonomous" ? theme.color.bg : theme.color.headingText,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: theme.space.m }}>
            <span style={{ fontSize: 20 }}>{displayedMode === "autonomous" ? "🤖" : "🧑"}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {displayedMode === "autonomous" ? "Self-driving" : "Approval required"}
                {pendingMode !== null && (
                  <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.85 }}> (takes effect next poll)</span>
                )}
              </div>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                {displayedMode === "autonomous"
                  ? "Resizes are applied automatically once TypeSafe's confidence clears the auto-apply gate — no human step in between."
                  : "TypeSafe suggests a resize; a human reviews and applies it below."}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: theme.space.xs, flexShrink: 0 }}>
            {(["approval-gated", "autonomous"] as const).map((m) => (
              <button
                key={m}
                onClick={() => void handleSetMode(m)}
                disabled={m === displayedMode}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: `1px solid ${displayedMode === "autonomous" ? theme.color.bg : theme.color.border}`,
                  background: m === displayedMode ? (displayedMode === "autonomous" ? theme.color.bg : theme.color.primary) : "transparent",
                  color:
                    m === displayedMode
                      ? displayedMode === "autonomous"
                        ? theme.color.accent
                        : theme.color.bg
                      : "inherit",
                  cursor: m === displayedMode ? "default" : "pointer",
                  font: "inherit",
                  opacity: m === displayedMode ? 1 : 0.85,
                }}
              >
                {m === "autonomous" ? "🤖 Self-driving" : "🧑 Approval"}
              </button>
            ))}
          </div>
        </div>
        {modeChangeError && (
          <div
            style={{
              padding: `${theme.space.s}px ${theme.space.xl}px`,
              color: theme.color.failureText,
              fontSize: 12,
              borderBottom: `1px solid ${theme.color.border}`,
            }}
          >
            {modeChangeError}
          </div>
        )}

        <div style={{ padding: theme.space.xl }}>
          {monitorIsStale && (
            <div
              style={{
                borderLeft: `3px solid ${theme.color.warningBadge}`,
                paddingLeft: theme.space.l,
                marginBottom: theme.space.xl,
                color: theme.color.warningText,
                fontSize: 13,
              }}
            >
              This monitor is running against an older plan revision — the data below may not reflect the currently
              loaded plan. Restart <code style={monoStyle}>geodeploy monitor</code> against the current plan.json to
              refresh it.
            </div>
          )}
          {monitor.status === "error" && (
            <div style={{ color: theme.color.failureText, fontSize: 13, marginBottom: theme.space.xl }}>
              {monitor.error ?? "unknown error"}
            </div>
          )}

          {!resize ? (
            <div style={{ color: theme.color.mutedText, fontSize: 13 }}>(no resize decision recorded yet)</div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: theme.font.display,
                  color: theme.color.primary,
                  marginBottom: theme.space.m,
                }}
              >
                Observed utilization
              </div>
              <div style={{ marginBottom: theme.space.xl }}>
                {resize.utilization.regions.map((util) => (
                  <UtilizationRow key={util.geoId} util={util} />
                ))}
              </div>

              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: theme.font.display,
                  color: theme.color.primary,
                  marginBottom: theme.space.m,
                }}
              >
                Proposed actions
              </div>
              <div style={{ marginBottom: theme.space.m }}>
                {resize.actions.map((action) => (
                  <ActionRow key={action.geoId} action={action} />
                ))}
              </div>
              <div style={{ fontSize: 13, color: theme.color.mutedText, marginBottom: theme.space.xl }}>
                {resize.reason}
              </div>

              {resize.decisionRecords.length > 0 && (
                <>
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
                  <DecisionFlowChart records={resize.decisionRecords} />
                  <div style={{ marginBottom: theme.space.xl }}>
                    {resize.decisionRecords.map((record, i) => (
                      <DecisionRecordView key={i} record={record} index={i} />
                    ))}
                  </div>
                </>
              )}

              {resize.applied && (
                <div style={{ color: theme.color.successText, fontSize: 13 }}>
                  This resize has already been applied.
                </div>
              )}

              {canApply && (
                <div>
                  <button
                    onClick={handleApply}
                    disabled={applyState === "applying"}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "8px 16px",
                      borderRadius: 6,
                      border: "none",
                      background: theme.color.primary,
                      color: theme.color.bg,
                      cursor: applyState === "applying" ? "default" : "pointer",
                      opacity: applyState === "applying" ? 0.7 : 1,
                      font: "inherit",
                    }}
                  >
                    {applyState === "applying" ? "Applying…" : "Apply this resize"}
                  </button>
                  {applyState === "error" && (
                    <div style={{ color: theme.color.failureText, fontSize: 13, marginTop: theme.space.s }}>
                      {applyError}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
