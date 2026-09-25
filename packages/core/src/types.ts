import { z } from "zod";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderSchema = z.enum(["aws", "azure", "gcp"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const ALL_PROVIDERS: readonly Provider[] = ["aws", "azure", "gcp"];

export const DnsProviderSchema = z.enum(["route53", "ns1", "cloudflare"]);
export type DnsProvider = z.infer<typeof DnsProviderSchema>;
export const ALL_DNS_PROVIDERS: readonly DnsProvider[] = ["route53", "ns1", "cloudflare"];

// A candidate/price row is "live" when it came from a real, current API response
// this run, and "fixture" when it came from a recorded/hand-built snapshot because
// no credentials (or no public unauthenticated endpoint) were available.
export const RealismSchema = z.enum(["live", "fixture"]);
export type Realism = z.infer<typeof RealismSchema>;

// ---------------------------------------------------------------------------
// Input: DeploymentRequest
// ---------------------------------------------------------------------------

export const ResidencyClassSchema = z.enum(["eu-only", "us-only", "in-country", "none"]);
export type ResidencyClass = z.infer<typeof ResidencyClassSchema>;

export const CentroidSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
export type Centroid = z.infer<typeof CentroidSchema>;

export const TargetGeoSchema = z.object({
  id: z.string().min(1),
  centroid: CentroidSchema,
  weightPct: z.number().min(0).max(100),
  residency: ResidencyClassSchema.optional(),
});
export type TargetGeo = z.infer<typeof TargetGeoSchema>;

export const ImageSpecSchema = z.object({
  reference: z.string().min(1),
  manifestPath: z.string().optional(),
  platforms: z.array(z.string()).min(1),
  /** Points at a folder uploaded via the wizard's POST /api/build-context (see packages/cli/src/uiCmd.ts). Not read by the pricing/decision pipeline — a durable pointer only, for a future real image-build step. */
  buildContextId: z.string().optional(),
});
export type ImageSpec = z.infer<typeof ImageSpecSchema>;

export const WorkloadSpecSchema = z.object({
  manifests: z.array(z.string()).min(1),
  replicasPerRegion: z.number().int().positive(),
  requestsPerPod: z.object({ vcpu: z.number().positive(), memGiB: z.number().positive() }),
  egressGiBPerMonth: z.number().nonnegative(),
  storageGiB: z.number().nonnegative(),
});
export type WorkloadSpec = z.infer<typeof WorkloadSpecSchema>;

export const ConstraintsSchema = z.object({
  maxProviders: z.number().int().positive().default(2),
  allowedProviders: z.array(ProviderSchema).optional(),
  maxMonthlyUsd: z.number().positive().optional(),
  minCoverageScore: z.number().min(0).max(1).optional(),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const DeploymentRequestSchema = z.object({
  targetGeos: z.array(TargetGeoSchema).min(1),
  image: ImageSpecSchema,
  workload: WorkloadSpecSchema,
  constraints: ConstraintsSchema.default({ maxProviders: 2 }),
});
export type DeploymentRequest = z.infer<typeof DeploymentRequestSchema>;

// ---------------------------------------------------------------------------
// Pricing (packages/pricing output, packages/cost input)
// ---------------------------------------------------------------------------

export const ArchSchema = z.enum(["x86_64", "arm64"]);
export type Arch = z.infer<typeof ArchSchema>;

export const PriceQuoteSchema = z.object({
  provider: ProviderSchema,
  region: z.string(), // native region id
  sku: z.string(), // native SKU / instance type
  vcpu: z.number().positive(),
  memGiB: z.number().positive(),
  arch: ArchSchema,
  nodeUsdPerHour: z.number().nonnegative(),
  controlPlaneUsdPerHour: z.number().nonnegative(),
  egressUsdPerGiB: z.number().nonnegative(),
  blockStorageUsdPerGiBMonth: z.number().nonnegative(),
  loadBalancerUsdPerHour: z.number().nonnegative(),
  currency: z.literal("USD"),
  asOf: z.string(), // ISO timestamp
  realism: RealismSchema,
  source: z.string(), // API + query / fixture path, for audit
});
export type PriceQuote = z.infer<typeof PriceQuoteSchema>;

// ---------------------------------------------------------------------------
// Catalog (packages/catalog output)
// ---------------------------------------------------------------------------

export const RegionCandidateSchema = z.object({
  provider: ProviderSchema,
  region: z.string(),
  centroid: CentroidSchema,
  azCount: z.number().int().nonnegative(),
  gaStatus: z.boolean(),
  complianceFlags: z.array(z.string()).default([]),
  managedK8sService: z.string(), // "eks" | "aks" | "gke", kept as string for forward-compat
});
export type RegionCandidate = z.infer<typeof RegionCandidateSchema>;

// ---------------------------------------------------------------------------
// Cost (packages/cost output, packages/decide input)
// ---------------------------------------------------------------------------

export const CostBreakdownSchema = z.object({
  computeUsd: z.number().nonnegative(),
  controlPlaneUsd: z.number().nonnegative(),
  egressUsd: z.number().nonnegative(),
  storageUsd: z.number().nonnegative(),
  lbUsd: z.number().nonnegative(),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export const CandidateCostSchema = z.object({
  provider: ProviderSchema,
  region: z.string(),
  sku: z.string(),
  arch: ArchSchema,
  centroid: CentroidSchema,
  nodesNeeded: z.number().int().nonnegative(),
  monthlyUsd: z.number().nonnegative(),
  breakdown: CostBreakdownSchema,
  distanceKm: z.number().nonnegative(),
  azCount: z.number().int().nonnegative(),
  gaStatus: z.boolean(),
  complianceFlags: z.array(z.string()).default([]),
  realism: RealismSchema,
  provisionable: z.boolean(),
});
export type CandidateCost = z.infer<typeof CandidateCostSchema>;

// ---------------------------------------------------------------------------
// Provider/DNS readiness (packages/detect output; consumed by decide + provision)
// ---------------------------------------------------------------------------

// tier1 = presence check only (env/config-file existence, no network).
// tier2 = real identity check (network call). null means "not checked" —
// tier2 is only ever run at apply-time, and only for providers a plan actually needs.
export const ProviderReadinessSchema = z.object({
  provider: ProviderSchema,
  tier1: z.boolean(),
  tier2: z.boolean().nullable(),
  detail: z.string(),
});
export type ProviderReadiness = z.infer<typeof ProviderReadinessSchema>;

export const DnsReadinessSchema = z.object({
  provider: DnsProviderSchema,
  tier1: z.boolean(),
  tier2: z.boolean().nullable(),
  detail: z.string(),
});
export type DnsReadiness = z.infer<typeof DnsReadinessSchema>;

// ---------------------------------------------------------------------------
// Decision engine output (packages/decide output)
// ---------------------------------------------------------------------------

export const ConfidenceGateSchema = z.object({
  value: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  passed: z.boolean(),
});
export type ConfidenceGate = z.infer<typeof ConfidenceGateSchema>;

// A decision record is fully auditable: what was asked, what came back, and
// whether it was even asked at all (the deterministic fallback path asks nothing).
export const DecisionRecordSchema = z.object({
  geoId: z.string(),
  // Optional/defaulted so every DecisionRecord ever written to a plan.json
  // before this field existed still parses unchanged.
  kind: z.enum(["geo-selection", "resize"]).default("geo-selection"),
  mode: z.enum(["typesafe", "deterministic-fallback"]),
  state: z.unknown().optional(),
  questions: z.record(z.string(), z.unknown()).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  selection: z.object({
    provider: ProviderSchema,
    region: z.string(),
  }),
  gates: z.record(z.string(), ConfidenceGateSchema).optional(),
  composite: z.number().optional(),
  reason: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

// ---------------------------------------------------------------------------
// Module composition (packages/modules + packages/compose)
// ---------------------------------------------------------------------------

export const ModuleSelectionSchema = z.object({
  cluster: z.string(), // e.g. "cluster.aws.eks"
  registry: z.string(), // e.g. "registry.aws.ecr"
  ingress: z.string(),
  autoscaling: z.string(),
  sizing: z.string(),
});
export type ModuleSelection = z.infer<typeof ModuleSelectionSchema>;

// ---------------------------------------------------------------------------
// Final plan (packages/decide + packages/compose output; packages/report input)
// ---------------------------------------------------------------------------

export const RegionPlanSchema = z.object({
  geoId: z.string(),
  provider: ProviderSchema,
  region: z.string(),
  sku: z.string(),
  /** The chosen cloud region's real location — for mapping/visualization (e.g. the web GUI's globe). */
  centroid: CentroidSchema,
  /** The demand geo's real location — lets a consumer draw a demand-to-deployment arc without reloading the original request. */
  demandCentroid: CentroidSchema,
  nodesNeeded: z.number().int().nonnegative(),
  monthlyUsd: z.number().nonnegative(),
  provisionable: z.boolean(),
  modules: ModuleSelectionSchema,
});
export type RegionPlan = z.infer<typeof RegionPlanSchema>;

export const DnsPlanSchema = z.object({
  provider: DnsProviderSchema.nullable(),
  reason: z.string(),
});
export type DnsPlan = z.infer<typeof DnsPlanSchema>;

export const DeploymentPlanSchema = z.object({
  requestId: z.string(),
  createdAt: z.string(),
  regions: z.array(RegionPlanSchema),
  dns: DnsPlanSchema,
  totalMonthlyUsd: z.number().nonnegative(),
  decisionRecords: z.array(DecisionRecordSchema),
  allowedProviders: z.array(ProviderSchema),
  detectedProviders: z.array(ProviderSchema),
  notes: z.array(z.string()).default([]),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

// ---------------------------------------------------------------------------
// Apply/provisioning record (packages/provision + packages/cli output; the
// web GUI's "Pulumi State" modal input). Persisted to `apply.json` in every
// outcome — including a refusal — so "not yet provisioned" is always a real,
// loadable artifact instead of something a consumer has to infer from a
// missing file.
// ---------------------------------------------------------------------------

export const ProvisionOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  error: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
});
export type ProvisionOutcome = z.infer<typeof ProvisionOutcomeSchema>;

export const ApplyRecordSchema = z.object({
  requestId: z.string(),
  checkedAt: z.string(),
  refused: z.boolean(),
  blockers: z.array(z.string()).default([]),
  results: z.record(z.string(), ProvisionOutcomeSchema).optional(),
});
export type ApplyRecord = z.infer<typeof ApplyRecordSchema>;

// ---------------------------------------------------------------------------
// Live utilization observation (packages/observe output; packages/decide's
// resize input) and the resize/rebalance decision + monitor-loop record
// (packages/decide + packages/cli monitor output; the web GUI's resize panel
// input). Persisted to `monitor.json` alongside `plan.json`/`apply.json` —
// never the kubeconfig/credentials used to collect it, only the observed
// numbers and the decision made from them.
// ---------------------------------------------------------------------------

export const RegionUtilizationSchema = z.object({
  geoId: z.string(),
  observedAt: z.string(), // ISO timestamp
  cpuUsedCores: z.number().nonnegative(), // sum of metrics.k8s.io PodMetrics usage
  // nodeCount * vcpu-per-node-for-sku — the baseline cpuUsedCores is measured
  // against. Deliberately not "sum of pod resource requests": the workload
  // module applies the user's raw manifest verbatim and never enforces
  // requests exist, so allocatable node capacity is the only baseline that's
  // always well-defined regardless of manifest hygiene.
  cpuAllocatableCores: z.number().nonnegative(),
  cpuUtilPct: z.number().min(0), // cpuUsedCores / cpuAllocatableCores; not capped at 1 (bursting is real)
  nodeCount: z.number().int().nonnegative(),
  podCount: z.number().int().nonnegative(),
  // Set, with the other numeric fields at 0, when this region's Metrics API
  // query failed — mirrors provisionPlan's per-region failure isolation
  // (one region's failure never blocks reading the others).
  error: z.string().optional(),
});
export type RegionUtilization = z.infer<typeof RegionUtilizationSchema>;

export const UtilizationSnapshotSchema = z.object({
  requestId: z.string(),
  collectedAt: z.string(),
  regions: z.array(RegionUtilizationSchema),
});
export type UtilizationSnapshot = z.infer<typeof UtilizationSnapshotSchema>;

export const RegionResizeActionSchema = z.object({
  geoId: z.string(),
  action: z.enum(["no-change", "scale-up", "scale-down", "shift-out", "shift-in"]),
  newSku: z.string().optional(),
  newNodesNeeded: z.number().int().nonnegative().optional(),
  /** Present only for shift-out/shift-in: the paired region this capacity moved to/from. */
  pairedGeoId: z.string().optional(),
});
export type RegionResizeAction = z.infer<typeof RegionResizeActionSchema>;

export const ResizePlanSchema = z.object({
  requestId: z.string(),
  createdAt: z.string(),
  utilization: UtilizationSnapshotSchema,
  actions: z.array(RegionResizeActionSchema),
  updatedRegions: z.array(RegionPlanSchema), // ready to feed straight back into provisionPlan
  decisionRecords: z.array(DecisionRecordSchema),
  confidencePassed: z.boolean(),
  mode: z.enum(["approval-gated", "autonomous"]),
  applied: z.boolean(), // false until a human (approval mode) or the monitor loop itself (autonomous) triggers apply
  reason: z.string(),
});
export type ResizePlan = z.infer<typeof ResizePlanSchema>;

export const MonitorRecordSchema = z.object({
  requestId: z.string(),
  mode: z.enum(["approval-gated", "autonomous"]),
  pollIntervalMs: z.number().int().positive(),
  lastPolledAt: z.string().optional(),
  lastResize: ResizePlanSchema.optional(),
  /** Every resize decision produced by this monitor run, oldest first — the loop's audit trail. */
  history: z.array(ResizePlanSchema).default([]),
  status: z.enum(["running", "stopped", "error"]),
  error: z.string().optional(),
});
export type MonitorRecord = z.infer<typeof MonitorRecordSchema>;
