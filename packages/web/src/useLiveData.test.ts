import { describe, expect, it } from "vitest";
import { parseApplyEventData, parseMonitorEventData, parsePlanEventData } from "./useLiveData";

// Regression test: confirmed live that skipping the { plan }/{ apply } unwrap
// on the SSE payload set React state to the wrapper object itself, so every
// `plan.regions` access downstream threw "regions is undefined". These lock
// in the real wire shape the server (packages/cli's uiCmd.ts) actually sends.

describe("parsePlanEventData", () => {
  it("unwraps the { plan } envelope to the bare DeploymentPlan", () => {
    const wire = JSON.stringify({ plan: { requestId: "plan-1", regions: [{ geoId: "eu-central" }] } });
    const result = parsePlanEventData(wire);
    expect(result).not.toBeNull();
    expect((result as { regions: unknown[] }).regions).toHaveLength(1);
  });

  it("returns null for the plan-missing envelope shape", () => {
    expect(parsePlanEventData(JSON.stringify({ plan: null }))).toBeNull();
  });
});

describe("parseApplyEventData", () => {
  it("unwraps the { apply } envelope to the bare ApplyRecord", () => {
    const wire = JSON.stringify({ apply: { requestId: "plan-1", refused: true, blockers: ["x"] } });
    const result = parseApplyEventData(wire);
    expect(result).not.toBeNull();
    expect((result as { refused: boolean }).refused).toBe(true);
  });

  it("returns null for the apply-missing envelope shape", () => {
    expect(parseApplyEventData(JSON.stringify({ apply: null }))).toBeNull();
  });
});

describe("parseMonitorEventData", () => {
  it("unwraps the { monitor } envelope to the bare MonitorRecord", () => {
    const wire = JSON.stringify({ monitor: { requestId: "plan-1", mode: "approval-gated", status: "running" } });
    const result = parseMonitorEventData(wire);
    expect(result).not.toBeNull();
    expect((result as { status: string }).status).toBe("running");
  });

  it("returns null for the monitor-missing envelope shape", () => {
    expect(parseMonitorEventData(JSON.stringify({ monitor: null }))).toBeNull();
  });
});
