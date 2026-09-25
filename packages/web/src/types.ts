// Types only — `import type` so this tree-shakes away entirely. The server
// (packages/cli's `geodeploy ui`) already validates plan.json/apply.json with
// these same zod schemas before serving them, so the client trusts the JSON
// as-is and never imports zod or the schemas themselves.
export type {
  Provider,
  DnsProvider,
  Centroid,
  TargetGeo,
  DecisionRecord,
  ConfidenceGate,
  ModuleSelection,
  RegionPlan,
  DnsPlan,
  DeploymentPlan,
  WorkloadSpec,
  ProvisionOutcome,
  ApplyRecord,
  RegionUtilization,
  UtilizationSnapshot,
  RegionResizeAction,
  ResizePlan,
  MonitorRecord,
} from "@geodeploy/core";
