import { useEffect, useRef, useState } from "react";
import type { ApplyRecord, DeploymentPlan, MonitorRecord } from "./types";

export type RegionProvisionStatus = "running" | "succeeded" | "failed";

export interface ApplyProgress {
  regionStatus: Record<string, RegionProvisionStatus>;
  lines: Array<{ geoId: string; text: string; at: string }>;
}

const MAX_CLIENT_PROGRESS_LINES = 200;

export interface LiveData {
  plan: DeploymentPlan | null;
  apply: ApplyRecord | null;
  monitor: MonitorRecord | null;
  /** Live progress for a currently-running apply (see uiCmd.ts's POST /api/apply) — `null` whenever nothing is in flight. Cleared the moment the durable `apply` event lands, since that's the real outcome superseding it. */
  applyProgress: ApplyProgress | null;
  /** True once we've heard from the server at least once (fetch or SSE), so callers can distinguish "still loading" from "confirmed absent". */
  loaded: boolean;
}

/**
 * The server wraps every plan payload the same way, whether it comes from
 * `GET /api/plan` or the `plan` SSE event: `{ plan, error? }`, never the bare
 * `DeploymentPlan`. Pulled out as a standalone function (rather than inlined
 * in the SSE handler) so it's directly testable without a DOM/EventSource —
 * confirmed live, skipping this unwrap once shipped a `plan` state that was
 * actually the wrapper object, so every `plan.regions` access downstream
 * threw "regions is undefined".
 */
export function parsePlanEventData(raw: string): DeploymentPlan | null {
  const body = JSON.parse(raw) as { plan: DeploymentPlan | null };
  return body.plan;
}

export function parseApplyEventData(raw: string): ApplyRecord | null {
  const body = JSON.parse(raw) as { apply: ApplyRecord | null };
  return body.apply;
}

export function parseMonitorEventData(raw: string): MonitorRecord | null {
  const body = JSON.parse(raw) as { monitor: MonitorRecord | null };
  return body.monitor;
}

/**
 * Subscribes to GET /api/events (native EventSource, named events: "plan",
 * "apply", "monitor", "plan-missing", "apply-missing", "monitor-missing").
 * Also issues one GET /api/plan + GET /api/apply + GET /api/monitor on mount
 * as a fallback, so there's no blank flash while the SSE connection
 * negotiates.
 */
export function useLiveData(): LiveData {
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [apply, setApply] = useState<ApplyRecord | null>(null);
  const [monitor, setMonitor] = useState<MonitorRecord | null>(null);
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  const markLoaded = () => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      setLoaded(true);
    }
  };

  useEffect(() => {
    let cancelled = false;

    // Fallback fetch so the UI isn't blank while SSE negotiates.
    void (async () => {
      try {
        const [planRes, applyRes, monitorRes, applyProgressRes] = await Promise.all([
          fetch("/api/plan"),
          fetch("/api/apply"),
          fetch("/api/monitor"),
          fetch("/api/apply/progress"),
        ]);
        if (cancelled) return;
        if (planRes.ok) {
          const body = (await planRes.json()) as { plan: DeploymentPlan | null };
          setPlan(body.plan);
        }
        if (applyRes.ok) {
          const body = (await applyRes.json()) as { apply: ApplyRecord | null };
          setApply(body.apply);
        }
        if (monitorRes.ok) {
          const body = (await monitorRes.json()) as { monitor: MonitorRecord | null };
          setMonitor(body.monitor);
        }
        if (applyProgressRes.ok) {
          const body = (await applyProgressRes.json()) as
            | { inProgress: true; regionStatus: Record<string, RegionProvisionStatus>; lines: ApplyProgress["lines"] }
            | { inProgress: false };
          setApplyProgress(body.inProgress ? { regionStatus: body.regionStatus, lines: body.lines } : null);
        }
      } catch {
        // SSE (below) is the source of truth once connected; a failed
        // fallback fetch just means we keep showing the loading state.
      } finally {
        if (!cancelled) markLoaded();
      }
    })();

    const source = new EventSource("/api/events");

    source.addEventListener("plan", (event) => {
      setPlan(parsePlanEventData((event as MessageEvent<string>).data));
      markLoaded();
    });
    source.addEventListener("plan-missing", () => {
      setPlan(null);
      markLoaded();
    });
    source.addEventListener("apply", (event) => {
      setApply(parseApplyEventData((event as MessageEvent<string>).data));
      // A fresh apply.json write is always the real, durable outcome of
      // whatever was running — supersede any transient in-flight progress.
      setApplyProgress(null);
      markLoaded();
    });
    source.addEventListener("apply-missing", () => {
      setApply(null);
      markLoaded();
    });
    source.addEventListener("applyProgressSnapshot", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as ApplyProgress;
      setApplyProgress(data);
    });
    source.addEventListener("applyProgressStatus", (event) => {
      const { geoId, status } = JSON.parse((event as MessageEvent<string>).data) as {
        geoId: string;
        status: RegionProvisionStatus;
      };
      setApplyProgress((prev) => ({
        regionStatus: { ...(prev?.regionStatus ?? {}), [geoId]: status },
        lines: prev?.lines ?? [],
      }));
    });
    source.addEventListener("applyProgress", (event) => {
      const { geoId, chunk } = JSON.parse((event as MessageEvent<string>).data) as { geoId: string; chunk: string };
      setApplyProgress((prev) => {
        const lines = [...(prev?.lines ?? []), { geoId, text: chunk, at: new Date().toISOString() }];
        if (lines.length > MAX_CLIENT_PROGRESS_LINES) lines.shift();
        return { regionStatus: prev?.regionStatus ?? {}, lines };
      });
    });
    source.addEventListener("monitor", (event) => {
      setMonitor(parseMonitorEventData((event as MessageEvent<string>).data));
      markLoaded();
    });
    source.addEventListener("monitor-missing", () => {
      setMonitor(null);
      markLoaded();
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return { plan, apply, monitor, applyProgress, loaded };
}
