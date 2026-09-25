import { readFile } from "node:fs/promises";
import { normalizeGeo, knownGeoIds } from "@geodeploy/geo";
import type { DeploymentRequest, TargetGeo } from "@geodeploy/core";
import { DeploymentRequestSchema } from "@geodeploy/core";

/**
 * Resolves a plain list of geo ids (e.g. from the web GUI's wizard, which
 * only collects ids, not full `TargetGeo` objects) into real `TargetGeo[]`
 * via `normalizeGeo`, split into equal `weightPct` shares. Throws the same
 * clear, listable error as `loadDeploymentRequest` for any id that doesn't
 * resolve — one canonical error message for "unknown geo id" either way a
 * request reaches this pipeline.
 */
export function resolveGeoIds(ids: readonly string[]): TargetGeo[] {
  if (ids.length === 0) {
    throw new Error("targetGeoIds must not be empty");
  }
  const weightPct = 100 / ids.length;
  return ids.map((id) => {
    const canonical = normalizeGeo(id);
    if (!canonical) {
      throw new Error(`Unknown geo id "${id}". Known geo ids: ${knownGeoIds().join(", ")}.`);
    }
    return { id, centroid: canonical.centroid, residency: canonical.residency, weightPct };
  });
}

/**
 * Loads and validates a `DeploymentRequest` JSON file. As a convenience, a
 * `targetGeos[].centroid` (and `.residency`) may be omitted when `id`
 * resolves via `@geodeploy/geo`'s `normalizeGeo` — this fills them in from
 * the canonical geo table before schema validation, so example/request files
 * can just say `{ "id": "eu-central", "weightPct": 100 }`. A `centroid`
 * supplied explicitly is always left untouched.
 */
export async function loadDeploymentRequest(filePath: string): Promise<DeploymentRequest> {
  const raw = await readFile(filePath, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof data === "object" && data !== null && "targetGeos" in data && Array.isArray((data as Record<string, unknown>)["targetGeos"])) {
    const record = data as Record<string, unknown>;
    record["targetGeos"] = (record["targetGeos"] as unknown[]).map((entry) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const geo = entry as Record<string, unknown>;
      if (geo["centroid"] !== undefined || typeof geo["id"] !== "string") return geo;

      const canonical = normalizeGeo(geo["id"]);
      if (!canonical) {
        throw new Error(
          `targetGeos[].id "${geo["id"]}" has no centroid and does not resolve via normalizeGeo(). ` +
            `Either add an explicit centroid, or use one of: ${knownGeoIds().join(", ")}.`,
        );
      }
      return {
        ...geo,
        centroid: canonical.centroid,
        residency: geo["residency"] ?? canonical.residency,
      };
    });
  }

  return DeploymentRequestSchema.parse(data);
}
