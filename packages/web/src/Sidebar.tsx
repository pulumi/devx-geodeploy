import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import { endpointFor, pointColor, pointStatus } from "./pointColor";
import type { ApplyProgress, RegionProvisionStatus } from "./useLiveData";
import type { ApplyRecord, DeploymentPlan, MonitorRecord } from "./types";

const STATUS_LABEL: Record<ReturnType<typeof pointStatus>, string> = {
  succeeded: "Provisioned",
  failed: "Failed",
  "not-applied": "Not applied",
};

const REGION_PROVISION_COLOR: Record<RegionProvisionStatus, string> = {
  running: theme.color.infoText,
  succeeded: theme.color.successText,
  failed: theme.color.failureText,
};

/**
 * Deploy trigger for the whole plan (real EKS/AKS/GKE clusters, real cost) —
 * distinct from the resize monitor's own, lower-stakes "Apply this resize"
 * button (ResizePanel.tsx), which has no confirmation step at all. A full
 * plan deploy is a materially bigger action, so this requires an explicit
 * second click showing the plan's estimated monthly cost before it fires.
 */
function DeployButton({ plan, applyProgress }: { plan: DeploymentPlan; applyProgress: ApplyProgress | null }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [applyProgress?.lines.length]);

  async function handleConfirm(): Promise<void> {
    setConfirming(false);
    try {
      const res = await fetch("/api/apply", { method: "POST" });
      const body = (await res.json()) as { refused?: boolean; blockers?: string[]; error?: string };
      if (body.refused) setError(body.blockers?.join("; ") ?? "apply was refused");
      else if (body.error) setError(body.error);
      // Otherwise `{ started: true }` — applyProgress (pushed via SSE) takes it from here.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (applyProgress) {
    return (
      <div
        style={{
          marginTop: theme.space.m,
          padding: theme.space.m,
          borderRadius: 8,
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface50,
        }}
      >
        <style>{`
          @keyframes geodeploy-deploy-spin { to { transform: rotate(360deg); } }
        `}</style>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space.s, marginBottom: theme.space.xs }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: `2px solid ${theme.color.border}`,
              borderTopColor: theme.color.accent,
              animation: "geodeploy-deploy-spin 0.8s linear infinite",
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: theme.color.headingText }}>Deploying…</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space.xs, marginBottom: theme.space.xs }}>
          {plan.regions.map((region) => {
            const status = applyProgress.regionStatus[region.geoId];
            return (
              <span
                key={region.geoId}
                style={{ fontSize: 11, fontFamily: theme.font.mono, color: status ? REGION_PROVISION_COLOR[status] : theme.color.mutedText }}
              >
                {region.geoId}: {status ?? "pending"}
              </span>
            );
          })}
        </div>
        <div
          ref={logRef}
          style={{
            maxHeight: 90,
            overflowY: "auto",
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            borderRadius: 4,
            padding: theme.space.xs,
            fontFamily: theme.font.mono,
            fontSize: 10,
            color: theme.color.mutedText,
          }}
        >
          {applyProgress.lines.slice(-30).map((line, i) => (
            <div key={i}>
              [{line.geoId}] {line.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (confirming) {
    return (
      <div
        style={{
          marginTop: theme.space.m,
          padding: theme.space.m,
          borderRadius: 8,
          border: `1px solid ${theme.color.accent}`,
          background: theme.color.surface50,
        }}
      >
        <div style={{ fontSize: 12, color: theme.color.headingText, marginBottom: theme.space.s }}>
          Deploy {plan.regions.length} region{plan.regions.length === 1 ? "" : "s"} for real, at an estimated $
          {plan.totalMonthlyUsd.toFixed(2)}/mo?
        </div>
        <div style={{ display: "flex", gap: theme.space.s }}>
          <button
            onClick={() => void handleConfirm()}
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "5px 12px",
              borderRadius: 999,
              border: "none",
              background: theme.color.accent,
              color: theme.color.bg,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Confirm Deploy
          </button>
          <button
            onClick={() => setConfirming(false)}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "5px 12px",
              borderRadius: 999,
              border: `1px solid ${theme.color.border}`,
              background: "transparent",
              color: theme.color.mutedText,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        style={{
          marginTop: theme.space.m,
          fontSize: 12,
          fontWeight: 700,
          padding: "5px 14px",
          borderRadius: 999,
          border: "none",
          background: theme.color.accent,
          color: theme.color.bg,
          cursor: "pointer",
          font: "inherit",
          width: "fit-content",
        }}
      >
        Deploy
      </button>
      {error && (
        <div style={{ fontSize: 11, color: theme.color.failureText, marginTop: theme.space.xs, maxWidth: 280 }}>
          {error}
        </div>
      )}
    </>
  );
}

export interface SidebarProps {
  plan: DeploymentPlan | null;
  apply: ApplyRecord | null;
  monitor: MonitorRecord | null;
  applyProgress: ApplyProgress | null;
  /** Set by the wizard when this plan picked a DNS provider but no matching config was supplied — see uiCmd.ts's handlePlanSubmission. */
  dnsWarning?: string | null;
  onDismissDnsWarning?: () => void;
  loaded: boolean;
  selectedGeoId: string | null;
  onSelect: (geoId: string) => void;
  /** Opens the wizard on demand. Omitted only in contexts that don't offer it (there are none today, but keeps this prop optional rather than forcing every caller to wire it). */
  onNewPlan?: () => void;
  /** Opens the resize monitor panel. Only ever rendered when `monitor !== null` — there's nothing to show otherwise. */
  onOpenResize?: () => void;
}

export function Sidebar({
  plan,
  apply,
  monitor,
  applyProgress,
  dnsWarning,
  onDismissDnsWarning,
  loaded,
  selectedGeoId,
  onSelect,
  onNewPlan,
  onOpenResize,
}: SidebarProps) {
  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        borderRight: `1px solid ${theme.color.border}`,
        background: `linear-gradient(160deg, ${theme.color.bg} 0%, ${theme.color.sidebarGradientEnd} 100%)`,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: theme.space.xl,
          borderBottom: `1px solid ${theme.color.border}`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ fontSize: 18, fontWeight: 600, fontFamily: theme.font.display, color: theme.color.primary }}>
            GeoDeploy
          </div>
          {onNewPlan && (
            <button
              onClick={onNewPlan}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 999,
                border: `1px solid ${theme.color.border}`,
                background: "transparent",
                color: theme.color.primary,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              New Plan
            </button>
          )}
        </div>
        {plan && (
          <div style={{ fontSize: 12, color: theme.color.mutedText, marginTop: theme.space.xs }}>
            {plan.regions.length} region{plan.regions.length === 1 ? "" : "s"} · ${plan.totalMonthlyUsd.toFixed(2)}/mo
          </div>
        )}
        {plan && <DeployButton plan={plan} applyProgress={applyProgress} />}
        {dnsWarning && (
          <div
            style={{
              marginTop: theme.space.m,
              padding: theme.space.m,
              borderRadius: 8,
              border: `1px solid ${theme.color.warningBadge}`,
              background: theme.color.surface50,
              fontSize: 11,
              color: theme.color.warningText,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: theme.space.s }}>
              <span>{dnsWarning}</span>
              {onDismissDnsWarning && (
                <button
                  onClick={onDismissDnsWarning}
                  aria-label="Dismiss"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.color.warningText,
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  &times;
                </button>
              )}
            </div>
          </div>
        )}
        {monitor && onOpenResize && (
          <>
            {monitor.mode === "autonomous" && (
              <style>{`
                @keyframes geodeploy-selfdriving-pulse {
                  0%, 100% { box-shadow: 0 0 0 0 ${theme.color.accent}80; }
                  50% { box-shadow: 0 0 0 6px ${theme.color.accent}00; }
                }
              `}</style>
            )}
            <button
              onClick={onOpenResize}
              style={{
                display: "flex",
                alignItems: "center",
                gap: theme.space.xs,
                marginTop: theme.space.m,
                fontSize: 12,
                fontWeight: 700,
                padding: "5px 12px",
                borderRadius: 999,
                border: `1px solid ${monitor.mode === "autonomous" ? theme.color.accent : theme.color.border}`,
                background:
                  monitor.status === "error"
                    ? theme.color.failureBadge
                    : monitor.mode === "autonomous"
                      ? theme.color.accent
                      : monitor.lastResize && !monitor.lastResize.applied && monitor.lastResize.actions.some((a) => a.action !== "no-change")
                        ? theme.color.warningBadge
                        : "transparent",
                color:
                  monitor.status === "error" ||
                  monitor.mode === "autonomous" ||
                  (monitor.lastResize && !monitor.lastResize.applied && monitor.lastResize.actions.some((a) => a.action !== "no-change"))
                    ? theme.color.bg
                    : theme.color.primary,
                cursor: "pointer",
                font: "inherit",
                width: "fit-content",
                animation: monitor.mode === "autonomous" ? "geodeploy-selfdriving-pulse 2s ease-in-out infinite" : "none",
              }}
            >
              {monitor.mode === "autonomous" ? "🤖 Self-driving" : "Resize monitor"}
            </button>
          </>
        )}
      </div>

      {!loaded && (
        <div style={{ padding: theme.space.xl, color: theme.color.mutedText, fontSize: 13 }}>Loading…</div>
      )}
      {loaded && !plan && (
        <div style={{ padding: theme.space.xl, color: theme.color.mutedText, fontSize: 13 }}>
          No plan yet — run <code style={{ fontFamily: theme.font.mono }}>geodeploy plan</code>.
        </div>
      )}

      {plan?.regions.map((region) => {
        const selected = region.geoId === selectedGeoId;
        const color = pointColor(region, apply, plan.requestId);
        const status = pointStatus(region, apply, plan.requestId);
        const endpoint = endpointFor(region, apply, plan.requestId);
        return (
          <button
            key={region.geoId}
            onClick={() => onSelect(region.geoId)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: theme.space.xs,
              textAlign: "left",
              padding: theme.space.l,
              border: "none",
              borderBottom: `1px solid ${theme.color.border}`,
              borderLeft: selected ? `3px solid ${theme.color.selectionHighlight}` : "3px solid transparent",
              background: selected ? theme.color.surface100 : "transparent",
              color: theme.color.bodyText,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, color: theme.color.headingText }}>{region.geoId}</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: color,
                  color: theme.color.bg,
                  fontWeight: 600,
                }}
              >
                {STATUS_LABEL[status]}
              </span>
            </div>
            <div style={{ fontSize: 12, color: theme.color.mutedText }}>
              {region.provider}:{region.region}
            </div>
            <div style={{ fontSize: 12, color: theme.color.mutedText, fontFamily: theme.font.mono }}>
              ${region.monthlyUsd.toFixed(2)}/mo
            </div>
            {endpoint && (
              <div
                style={{ fontSize: 11, color: theme.color.successText, fontFamily: theme.font.mono, wordBreak: "break-all" }}
              >
                {endpoint}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
