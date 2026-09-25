import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { theme } from "./theme";
import { parseDockerfile } from "./dockerfileParser";
import type { DockerfileHints } from "./dockerfileParser";
import { collectFilesFromDataTransferItems, containsDirectory, encodeFilesForUpload, findDockerfilePath } from "./folderUpload";
import { ditheredModalBackdropCss } from "./modalBackdrop";
import type { DeploymentPlan, WorkloadSpec } from "./types";

export interface WizardProps {
  /** Called with the POST response's plan on success, so App.tsx can show it immediately (SSE will confirm it moments later). */
  onPlanCreated: (plan: DeploymentPlan, dnsWarning?: string) => void;
}

const KNOWN_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

// Mirrors packages/cli/src/uiCmd.ts's DEFAULT_WORKLOAD exactly, which itself
// mirrors examples/sample-request.json — pre-filling these keeps the wizard's
// "customize workload" panel consistent with what the server defaults to
// when `workload` is omitted entirely.
const DEFAULT_WORKLOAD: WorkloadSpec = {
  manifests: ["k8s/deployment.yaml", "k8s/service.yaml"],
  replicasPerRegion: 2,
  requestsPerPod: { vcpu: 1, memGiB: 2 },
  egressGiBPerMonth: 50,
  storageGiB: 20,
};

// Mirrors packages/cli/src/uiCmd.ts's DEFAULT_INGRESS exactly, for the same
// reason DEFAULT_WORKLOAD does above.
const DEFAULT_INGRESS_SELECTOR_TEXT = "app=demo";
const DEFAULT_INGRESS_PORTS_TEXT = "80:80";

/** Mirrors packages/compose's ComposeIngressConfig -- kept as a local shape
 * rather than a cross-package dependency, since the wizard only ever needs
 * to produce this JSON, never consume the real type. */
export interface IngressConfig {
  selector: Record<string, string>;
  ports: Array<{ port: number; targetPort: number }>;
}

export interface DnsInput {
  recordName: string;
  route53ZoneId: string;
}

/**
 * A random default record name, so the field isn't blank/effortful to fill
 * in for a quick test — unlike the Route53 hosted zone ID, which cannot be
 * defaulted (it must match a zone that actually exists in the user's own
 * AWS account, so a random one would just fail cleanly at deploy time
 * instead of being easier). "example.com" is a placeholder the user is
 * still expected to replace with their own real domain, same spirit as the
 * wizard's other pre-filled-but-generic defaults (`k8s/deployment.yaml`, etc).
 */
export function randomDnsRecordName(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `app-${suffix}.example.com`;
}

interface WizardPlanRequestBody {
  image: { reference: string; platforms: string[]; buildContextId?: string };
  targetGeoIds: string[];
  workload?: Partial<WorkloadSpec>;
  ingress?: IngressConfig;
  dns?: DnsInput;
}

/** Parses "key=value, key2=value2" into a label selector. Blank/malformed pairs are silently dropped rather than erroring — this is a wizard convenience field, not a strict config format. */
export function parseIngressSelector(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

/** Parses "80:80, 443:8443" (or bare "80" meaning port:targetPort are the same) into a ports list. */
export function parseIngressPorts(text: string): Array<{ port: number; targetPort: number }> {
  const result: Array<{ port: number; targetPort: number }> = [];
  for (const pair of text.split(",")) {
    const [portStr, targetStr] = pair.split(":").map((s) => s.trim());
    const port = Number(portStr);
    const targetPort = targetStr !== undefined && targetStr !== "" ? Number(targetStr) : port;
    if (Number.isFinite(port) && port > 0 && Number.isFinite(targetPort) && targetPort > 0) {
      result.push({ port, targetPort });
    }
  }
  return result;
}

/**
 * Pure request-body builder, pulled out of the submit handler so it's
 * directly testable (same pattern as useLiveData's parse*EventData): only
 * includes `workload`/`ingress` when the caller says the user actually
 * touched those advanced fields, otherwise the server's own defaults apply.
 * `buildContextId` is included only when a folder was actually uploaded (see
 * folderUpload.ts) — a plain single-Dockerfile or no-Dockerfile submission
 * never has one.
 */
export function buildPlanRequestBody(input: {
  imageReference: string;
  platforms: string[];
  targetGeoIds: string[];
  workload: WorkloadSpec;
  workloadTouched: boolean;
  ingress: IngressConfig;
  ingressTouched: boolean;
  /** No sensible default exists (unlike workload/ingress) — included only when both fields are actually filled in, regardless of a "touched" flag. */
  dns?: DnsInput;
  buildContextId?: string | null;
}): WizardPlanRequestBody {
  return {
    image: {
      reference: input.imageReference.trim(),
      platforms: input.platforms,
      ...(input.buildContextId ? { buildContextId: input.buildContextId } : {}),
    },
    targetGeoIds: input.targetGeoIds,
    ...(input.workloadTouched ? { workload: input.workload } : {}),
    ...(input.ingressTouched ? { ingress: input.ingress } : {}),
    ...(input.dns ? { dns: input.dns } : {}),
  };
}

/** Builds the DNS input from the two raw text fields, or `undefined` if either is blank — DNS is only included in the request once both are actually filled in. */
export function buildDnsInput(recordName: string, route53ZoneId: string): DnsInput | undefined {
  const trimmedRecordName = recordName.trim();
  const trimmedZoneId = route53ZoneId.trim();
  return trimmedRecordName && trimmedZoneId ? { recordName: trimmedRecordName, route53ZoneId: trimmedZoneId } : undefined;
}

/** Reconciles a freshly-parsed Dockerfile's platform hints with the fixed amd64/arm64 checkbox set: only adopts the detected platforms when at least one of them is one we can actually show a checkbox for. */
export function reconcilePlatformSelection(hints: DockerfileHints): string[] {
  const known = hints.platforms.filter((p) => (KNOWN_PLATFORMS as readonly string[]).includes(p));
  return known.length > 0 ? known : [...KNOWN_PLATFORMS];
}

/**
 * The image reference isn't actually load-bearing for planning — the
 * pricing/decision pipeline only ever reads `image.platforms` (for the
 * architecture-compatibility filter); `plan.json` doesn't even persist the
 * reference string anywhere. So it's not a required step: when the user
 * leaves it blank, derive a clearly-a-placeholder value from the Dockerfile's
 * final stage (if one was dropped) so the request is still valid, without
 * making the user type or know a real registry path before seeing a
 * recommendation. A real reference only starts to matter later, at apply
 * time, when an image actually needs to be built and pushed somewhere.
 */
export function derivePlaceholderImageReference(hints: DockerfileHints | null): string {
  const lastStage = hints?.baseImages[hints.baseImages.length - 1];
  if (!lastStage) return "pending-build/app:latest";
  const slug = lastStage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `pending-build/${slug || "app"}:latest`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const panelStyle: CSSProperties = {
  width: theme.dialogWidth.large,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "calc(100vh - 64px)",
  overflowY: "auto",
  background: theme.color.surface50,
  border: `1px solid ${theme.color.border}`,
  borderRadius: 10,
  color: theme.color.bodyText,
  fontFamily: theme.font.sans,
  padding: theme.space["2x"],
};

const sectionStyle: CSSProperties = { marginBottom: theme.space["2x"] };
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: theme.color.headingText,
  marginBottom: theme.space.s,
};
const helperStyle: CSSProperties = { fontSize: 12, color: theme.color.mutedText, marginTop: theme.space.xs };
const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${theme.space.m}px ${theme.space.l}px`,
  // surface50 (near-white), not surface100 (a pale-yellow tone very close to
  // the page background) — confirmed live: with surface100, every input
  // field visually blended into the page background, reading as "the labels
  // have a pale-yellow background" since there was so little contrast
  // between an input and the page around it.
  background: theme.color.surface50,
  border: `1px solid ${theme.color.border}`,
  borderRadius: 6,
  color: theme.color.bodyText,
  font: "inherit",
  fontSize: 14,
};
const smallInputStyle: CSSProperties = { ...inputStyle, width: 96 };

export function Wizard({ onPlanCreated }: WizardProps) {
  // Dockerfile drop zone.
  const [dragOver, setDragOver] = useState(false);
  const [dockerfileHints, setDockerfileHints] = useState<DockerfileHints | null>(null);
  const [dockerfileName, setDockerfileName] = useState<string | null>(null);
  const [dockerfileError, setDockerfileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Whole-folder drop zone (see folderUpload.ts) — a real build context
  // uploaded and stored server-side, independent of the single-Dockerfile
  // hint-parsing above (both can populate dockerfileHints/dockerfileName).
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "uploaded" | "error">("idle");
  const [buildContextId, setBuildContextId] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{
    fileCount: number;
    totalBytes: number;
    dockerfilePath: string;
  } | null>(null);

  // Core required fields.
  const [imageReference, setImageReference] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([...KNOWN_PLATFORMS]);

  // Target regions.
  const [knownGeoIds, setKnownGeoIds] = useState<string[] | null>(null);
  const [geoIdsError, setGeoIdsError] = useState<string | null>(null);
  const [selectedGeoIds, setSelectedGeoIds] = useState<Set<string>>(new Set());

  // Advanced workload, collapsed by default.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [workloadTouched, setWorkloadTouched] = useState(false);
  const [replicasPerRegion, setReplicasPerRegion] = useState(DEFAULT_WORKLOAD.replicasPerRegion);
  const [vcpu, setVcpu] = useState(DEFAULT_WORKLOAD.requestsPerPod.vcpu);
  const [memGiB, setMemGiB] = useState(DEFAULT_WORKLOAD.requestsPerPod.memGiB);
  const [egressGiBPerMonth, setEgressGiBPerMonth] = useState(DEFAULT_WORKLOAD.egressGiBPerMonth);
  const [storageGiB, setStorageGiB] = useState(DEFAULT_WORKLOAD.storageGiB);
  const [manifestsText, setManifestsText] = useState(DEFAULT_WORKLOAD.manifests.join("\n"));
  const [ingressTouched, setIngressTouched] = useState(false);
  const [ingressSelectorText, setIngressSelectorText] = useState(DEFAULT_INGRESS_SELECTOR_TEXT);
  const [ingressPortsText, setIngressPortsText] = useState(DEFAULT_INGRESS_PORTS_TEXT);
  const [dnsRecordName, setDnsRecordName] = useState(() => randomDnsRecordName());
  const [dnsRoute53ZoneId, setDnsRoute53ZoneId] = useState("");

  // Submission.
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/known-geos");
        if (!res.ok) throw new Error(`GET /api/known-geos failed: ${res.status}`);
        const body = (await res.json()) as { geoIds: string[] };
        if (!cancelled) setKnownGeoIds(body.geoIds);
      } catch (err) {
        if (!cancelled) setGeoIdsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status !== "submitting") return;
    const start = Date.now();
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  function handleDockerfileText(text: string, name: string) {
    setDockerfileError(null);
    try {
      const hints = parseDockerfile(text);
      setDockerfileHints(hints);
      setDockerfileName(name);
      setPlatforms(reconcilePlatformSelection(hints));
    } catch (err) {
      setDockerfileError(err instanceof Error ? err.message : String(err));
    }
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") handleDockerfileText(reader.result, file.name);
    };
    reader.onerror = () =>
      setDockerfileError(
        "Could not read that as a text file. If you dropped a folder, your browser may not support reading its " +
          "contents here — try Chrome or Firefox, or drop the Dockerfile itself instead.",
      );
    reader.readAsText(file);
  }

  /**
   * A whole folder was dropped (see folderUpload.ts's `containsDirectory`).
   * Finds the Dockerfile within it for the same hint-parsing the single-file
   * path already does, then uploads the whole (filtered) folder to
   * POST /api/build-context so it's durably captured server-side.
   */
  async function handleFolderDrop(items: DataTransferItemList) {
    setDockerfileError(null);
    setUploadStatus("uploading");
    setUploadSummary(null);
    setBuildContextId(null);
    try {
      const entries = await collectFilesFromDataTransferItems(items);
      const dockerfilePath = findDockerfilePath(entries);
      if (!dockerfilePath) {
        throw new Error("No Dockerfile found anywhere in that folder.");
      }
      const dockerfileEntry = entries.find((e) => e.relativePath === dockerfilePath)!;
      const dockerfileText = await dockerfileEntry.file.text();
      handleDockerfileText(dockerfileText, dockerfilePath);

      const files = await encodeFilesForUpload(entries);
      const res = await fetch("/api/build-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      const body = (await res.json()) as {
        buildContextId?: string;
        dockerfilePath?: string;
        fileCount?: number;
        totalBytes?: number;
        error?: string;
      };
      if (!res.ok || !body.buildContextId) {
        throw new Error(body.error ?? `Upload failed with status ${res.status}`);
      }
      setBuildContextId(body.buildContextId);
      setUploadSummary({
        fileCount: body.fileCount ?? entries.length,
        totalBytes: body.totalBytes ?? 0,
        dockerfilePath: body.dockerfilePath ?? dockerfilePath,
      });
      setUploadStatus("uploaded");
    } catch (err) {
      setUploadStatus("error");
      setDockerfileError(err instanceof Error ? err.message : String(err));
    }
  }

  function togglePlatform(platform: string) {
    setPlatforms((prev) => (prev.includes(platform) ? prev.filter((p) => p !== platform) : [...prev, platform]));
  }

  function toggleGeoId(geoId: string) {
    setSelectedGeoIds((prev) => {
      const next = new Set(prev);
      if (next.has(geoId)) next.delete(geoId);
      else next.add(geoId);
      return next;
    });
  }

  // Image reference is optional now — see derivePlaceholderImageReference's
  // doc comment for why it isn't required to see a real recommendation.
  const canSubmit = platforms.length > 0 && selectedGeoIds.size > 0 && status !== "submitting";

  async function handleSubmit() {
    if (!canSubmit) return;
    setStatus("submitting");
    setSubmitError(null);

    const workload: WorkloadSpec = {
      manifests: manifestsText
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0),
      replicasPerRegion,
      requestsPerPod: { vcpu, memGiB },
      egressGiBPerMonth,
      storageGiB,
    };

    const ingress: IngressConfig = {
      selector: parseIngressSelector(ingressSelectorText),
      ports: parseIngressPorts(ingressPortsText),
    };

    const dns = buildDnsInput(dnsRecordName, dnsRoute53ZoneId);
    const body = buildPlanRequestBody({
      imageReference: imageReference.trim() || derivePlaceholderImageReference(dockerfileHints),
      platforms,
      targetGeoIds: [...selectedGeoIds],
      workload,
      workloadTouched,
      ingress,
      ingressTouched,
      ...(dns ? { dns } : {}),
      buildContextId,
    });

    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseBody = (await res.json()) as { plan?: DeploymentPlan; error?: string; dnsWarning?: string };
      if (!res.ok) {
        setStatus("error");
        setSubmitError(responseBody.error ?? `Request failed with status ${res.status}`);
        return;
      }
      if (!responseBody.plan) {
        setStatus("error");
        setSubmitError("Server returned 200 but no plan — this looks like a server bug.");
        return;
      }
      setStatus("idle");
      onPlanCreated(responseBody.plan, responseBody.dnsWarning);
    } catch (err) {
      setStatus("error");
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        width: "100%",
        // Larger source image than the smaller tiled modals (RegionModal/
        // ResizePanel default to 220px) — this one gets stretched across the
        // whole viewport via `cover` below, so a bigger source avoids
        // visibly blurring out into an upscaled 220px tile.
        background: ditheredModalBackdropCss(800),
        // "cover" (not a tiled fixed size, like the smaller modals use) —
        // the wizard fills the whole viewport, so a single stretched
        // instance of the pattern reads as a backdrop rather than a
        // small-tile texture repeating across a large area.
        backgroundSize: "cover",
        padding: theme.space["2x"],
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      <div style={panelStyle}>
        <div style={{ marginBottom: theme.space["2x"] }}>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: theme.font.display, color: theme.color.primary }}>
            New deployment plan
          </div>
          <div style={{ ...helperStyle, marginTop: theme.space.s }}>
            Pick target regions (and optionally drop a Dockerfile for platform hints) — GeoDeploy will price real
            regions and build a plan. Image reference and workload shape are optional and can be set later.
          </div>
        </div>

        {/* Dockerfile / build-context drop zone */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Dockerfile or project folder (optional)</label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (containsDirectory(e.dataTransfer.items)) {
                void handleFolderDrop(e.dataTransfer.items);
                return;
              }
              const file = e.dataTransfer.files[0];
              if (file) readFile(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `1px dashed ${dragOver ? theme.color.primary : theme.color.border}`,
              borderRadius: 8,
              padding: theme.space.xl,
              textAlign: "center",
              cursor: "pointer",
              background: dragOver ? theme.color.surface100 : "transparent",
              color: theme.color.mutedText,
              fontSize: 13,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
              }}
              style={{ display: "none" }}
            />
            {uploadStatus === "uploading" ? (
              <span>Bundling and uploading your folder&hellip;</span>
            ) : uploadSummary ? (
              <span style={{ color: theme.color.bodyText }}>
                Bundled {uploadSummary.fileCount} file{uploadSummary.fileCount === 1 ? "" : "s"} (
                {(uploadSummary.totalBytes / 1024).toFixed(0)} KB) — Dockerfile at {uploadSummary.dockerfilePath}
              </span>
            ) : dockerfileName ? (
              <span style={{ color: theme.color.bodyText }}>Loaded {dockerfileName}</span>
            ) : (
              <span>Drag a Dockerfile or a whole project folder here, or click to browse a Dockerfile</span>
            )}
          </div>
          {dockerfileError && (
            <div style={{ ...helperStyle, color: theme.color.failureText }}>{dockerfileError}</div>
          )}
          {dockerfileHints && !uploadSummary && (
            <div style={helperStyle}>
              Detected: {dockerfileHints.baseImages.join(" → ") || "(no FROM lines found)"} &middot; platforms:{" "}
              {dockerfileHints.platforms.join(", ")}
            </div>
          )}
        </div>

        {/* Platforms */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Platforms *</label>
          <div style={{ display: "flex", gap: theme.space.xl }}>
            {KNOWN_PLATFORMS.map((platform) => (
              <label
                key={platform}
                style={{ display: "flex", alignItems: "center", gap: theme.space.s, fontSize: 13, cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={platforms.includes(platform)}
                  onChange={() => togglePlatform(platform)}
                />
                {platform}
              </label>
            ))}
          </div>
        </div>

        {/* Target regions */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Target regions *</label>
          {geoIdsError && (
            <div style={{ ...helperStyle, color: theme.color.failureText }}>
              Could not load known regions: {geoIdsError}
            </div>
          )}
          {!geoIdsError && knownGeoIds === null && <div style={helperStyle}>Loading known regions&hellip;</div>}
          {knownGeoIds && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: theme.space.s,
                maxHeight: 200,
                overflowY: "auto",
                border: `1px solid ${theme.color.border}`,
                borderRadius: 6,
                padding: theme.space.l,
              }}
            >
              {knownGeoIds.map((geoId) => (
                <label
                  key={geoId}
                  style={{ display: "flex", alignItems: "center", gap: theme.space.s, fontSize: 13, cursor: "pointer" }}
                >
                  <input type="checkbox" checked={selectedGeoIds.has(geoId)} onChange={() => toggleGeoId(geoId)} />
                  {geoId}
                </label>
              ))}
            </div>
          )}
          <div style={helperStyle}>Weights are split equally across selected regions, computed server-side.</div>
        </div>

        {/* Advanced workload */}
        <div style={sectionStyle}>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              color: theme.color.primary,
              fontSize: 13,
              cursor: "pointer",
              padding: 0,
              font: "inherit",
            }}
          >
            {showAdvanced ? "▾" : "▸"} Image reference &amp; workload (optional)
          </button>
          {showAdvanced && (
            <div
              style={{
                marginTop: theme.space.l,
                display: "flex",
                flexDirection: "column",
                gap: theme.space.l,
                border: `1px solid ${theme.color.border}`,
                borderRadius: 8,
                padding: theme.space.l,
              }}
            >
              <div>
                <input
                  id="wizard-image-reference"
                  type="text"
                  aria-label="Image reference"
                  value={imageReference}
                  onChange={(e) => setImageReference(e.target.value)}
                  placeholder={`optional — defaults to ${derivePlaceholderImageReference(dockerfileHints)}`}
                  style={inputStyle}
                />
                <div style={helperStyle}>
                  Not needed for a recommendation — only matters once you actually deploy. Set it here if you already
                  know where you&apos;ll push the image.
                </div>
              </div>
              <div style={{ display: "flex", gap: theme.space.xl, flexWrap: "wrap" }}>
                <div>
                  <label style={labelStyle} htmlFor="wizard-replicas">
                    Replicas per region
                  </label>
                  <input
                    id="wizard-replicas"
                    type="number"
                    min={1}
                    value={replicasPerRegion}
                    onChange={(e) => {
                      setWorkloadTouched(true);
                      setReplicasPerRegion(Number(e.target.value));
                    }}
                    style={smallInputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wizard-vcpu">
                    vCPU per pod
                  </label>
                  <input
                    id="wizard-vcpu"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={vcpu}
                    onChange={(e) => {
                      setWorkloadTouched(true);
                      setVcpu(Number(e.target.value));
                    }}
                    style={smallInputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wizard-mem">
                    Memory per pod (GiB)
                  </label>
                  <input
                    id="wizard-mem"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={memGiB}
                    onChange={(e) => {
                      setWorkloadTouched(true);
                      setMemGiB(Number(e.target.value));
                    }}
                    style={smallInputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wizard-egress">
                    Egress (GiB/mo)
                  </label>
                  <input
                    id="wizard-egress"
                    type="number"
                    min={0}
                    value={egressGiBPerMonth}
                    onChange={(e) => {
                      setWorkloadTouched(true);
                      setEgressGiBPerMonth(Number(e.target.value));
                    }}
                    style={smallInputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wizard-storage">
                    Storage (GiB)
                  </label>
                  <input
                    id="wizard-storage"
                    type="number"
                    min={0}
                    value={storageGiB}
                    onChange={(e) => {
                      setWorkloadTouched(true);
                      setStorageGiB(Number(e.target.value));
                    }}
                    style={smallInputStyle}
                  />
                </div>
              </div>
              <div>
                <label style={labelStyle} htmlFor="wizard-manifests">
                  Manifests (one path per line)
                </label>
                <textarea
                  id="wizard-manifests"
                  value={manifestsText}
                  onChange={(e) => {
                    setWorkloadTouched(true);
                    setManifestsText(e.target.value);
                  }}
                  rows={3}
                  style={{ ...inputStyle, fontFamily: theme.font.mono, resize: "vertical" }}
                />
              </div>
              <div style={{ display: "flex", gap: theme.space.m }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle} htmlFor="wizard-ingress-selector">
                    Ingress selector (key=value, ...)
                  </label>
                  <input
                    id="wizard-ingress-selector"
                    type="text"
                    value={ingressSelectorText}
                    onChange={(e) => {
                      setIngressTouched(true);
                      setIngressSelectorText(e.target.value);
                    }}
                    style={{ ...smallInputStyle, fontFamily: theme.font.mono, width: "100%" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle} htmlFor="wizard-ingress-ports">
                    Ports (port:targetPort, ...)
                  </label>
                  <input
                    id="wizard-ingress-ports"
                    type="text"
                    value={ingressPortsText}
                    onChange={(e) => {
                      setIngressTouched(true);
                      setIngressPortsText(e.target.value);
                    }}
                    style={{ ...smallInputStyle, fontFamily: theme.font.mono, width: "100%" }}
                  />
                </div>
              </div>
              <div style={{ fontSize: 11, color: theme.color.mutedText }}>
                Must match your manifests' actual pod labels/ports — this is what `geodeploy apply` uses to build the
                real Kubernetes Service, not the ingress posture TypeSafe already decided.
              </div>
              <div style={{ display: "flex", gap: theme.space.m }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle} htmlFor="wizard-dns-record">
                    DNS record name (optional)
                  </label>
                  <input
                    id="wizard-dns-record"
                    type="text"
                    placeholder="api.example.com"
                    value={dnsRecordName}
                    onChange={(e) => setDnsRecordName(e.target.value)}
                    style={{ ...smallInputStyle, fontFamily: theme.font.mono, width: "100%" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle} htmlFor="wizard-dns-zone">
                    Route53 hosted zone ID
                  </label>
                  <input
                    id="wizard-dns-zone"
                    type="text"
                    placeholder="Z0123456789ABCDEFGHIJ"
                    value={dnsRoute53ZoneId}
                    onChange={(e) => setDnsRoute53ZoneId(e.target.value)}
                    style={{ ...smallInputStyle, fontFamily: theme.font.mono, width: "100%" }}
                  />
                </div>
              </div>
              <div style={{ fontSize: 11, color: theme.color.mutedText }}>
                Only needed if this plan ends up selecting Route53 for DNS (based on your real AWS credentials at plan
                time). The record name is a random placeholder — replace it with your real domain. The hosted zone ID
                can't be defaulted: it must match a zone that actually exists in your AWS account. Leave the zone ID
                blank to skip DNS entirely. Only Route53 is supported here; NS1/Cloudflare still require a
                hand-authored config.json.
              </div>
            </div>
          )}
        </div>

        {/* Submission */}
        {status === "submitting" && (
          <div
            style={{
              marginBottom: theme.space.xl,
              padding: theme.space.l,
              borderRadius: 6,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface100,
              color: theme.color.infoText,
              fontSize: 13,
            }}
          >
            Generating your plan&hellip; {formatElapsed(elapsedSeconds)} elapsed. This can take a few minutes — AWS's
            pricing data is large.
          </div>
        )}
        {status === "error" && submitError && (
          <div
            style={{
              marginBottom: theme.space.xl,
              padding: theme.space.l,
              borderRadius: 6,
              border: `1px solid ${theme.color.failureBadge}`,
              background: theme.color.surface100,
              color: theme.color.failureText,
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: theme.space.xs }}>Couldn&apos;t create a plan</div>
            <div>{submitError}</div>
          </div>
        )}

        <button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            width: "100%",
            padding: theme.space.l,
            borderRadius: 6,
            border: "none",
            background: canSubmit ? theme.color.primary : theme.color.surface100,
            color: canSubmit ? theme.color.bg : theme.color.mutedText,
            fontWeight: 600,
            fontSize: 14,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {status === "submitting"
            ? `Generating… ${formatElapsed(elapsedSeconds)}`
            : status === "error"
              ? "Retry"
              : "Create plan"}
        </button>
      </div>
    </div>
  );
}
