import { describe, expect, it } from "vitest";
import {
  buildDnsInput,
  buildPlanRequestBody,
  derivePlaceholderImageReference,
  parseIngressPorts,
  parseIngressSelector,
  randomDnsRecordName,
  reconcilePlatformSelection,
} from "./Wizard";

describe("derivePlaceholderImageReference", () => {
  it("derives a placeholder from the Dockerfile's final stage when one was dropped", () => {
    const ref = derivePlaceholderImageReference({ baseImages: ["golang:1.22", "node:20-alpine"], platforms: [] });
    expect(ref).toBe("pending-build/node-20-alpine:latest");
  });

  it("falls back to a generic placeholder when no Dockerfile was dropped", () => {
    expect(derivePlaceholderImageReference(null)).toBe("pending-build/app:latest");
  });

  it("falls back to a generic placeholder when a Dockerfile had no FROM lines", () => {
    expect(derivePlaceholderImageReference({ baseImages: [], platforms: [] })).toBe("pending-build/app:latest");
  });
});

describe("reconcilePlatformSelection", () => {
  it("adopts detected platforms that overlap the known checkbox set", () => {
    expect(reconcilePlatformSelection({ baseImages: [], platforms: ["linux/arm64"] })).toEqual(["linux/arm64"]);
  });

  it("falls back to both known platforms when nothing detected overlaps", () => {
    expect(reconcilePlatformSelection({ baseImages: [], platforms: ["linux/386"] })).toEqual([
      "linux/amd64",
      "linux/arm64",
    ]);
  });
});

describe("parseIngressSelector", () => {
  it("parses a single key=value pair", () => {
    expect(parseIngressSelector("app=demo")).toEqual({ app: "demo" });
  });

  it("parses multiple comma-separated pairs", () => {
    expect(parseIngressSelector("app=demo, tier=web")).toEqual({ app: "demo", tier: "web" });
  });

  it("silently drops blank or malformed entries", () => {
    expect(parseIngressSelector("app=demo, , tier, =blank, real=value")).toEqual({ app: "demo", real: "value" });
  });

  it("returns an empty object for an empty string", () => {
    expect(parseIngressSelector("")).toEqual({});
  });
});

describe("parseIngressPorts", () => {
  it("parses a single port:targetPort pair", () => {
    expect(parseIngressPorts("80:8080")).toEqual([{ port: 80, targetPort: 8080 }]);
  });

  it("parses multiple comma-separated pairs", () => {
    expect(parseIngressPorts("80:80, 443:8443")).toEqual([
      { port: 80, targetPort: 80 },
      { port: 443, targetPort: 8443 },
    ]);
  });

  it("treats a bare port (no colon) as port:targetPort being the same value", () => {
    expect(parseIngressPorts("80")).toEqual([{ port: 80, targetPort: 80 }]);
  });

  it("silently drops non-numeric or zero/negative entries", () => {
    expect(parseIngressPorts("80:80, not-a-port, 0:0, -1:-1, 443:443")).toEqual([
      { port: 80, targetPort: 80 },
      { port: 443, targetPort: 443 },
    ]);
  });
});

const defaultWorkload = {
  manifests: [] as string[],
  replicasPerRegion: 1,
  requestsPerPod: { vcpu: 1, memGiB: 1 },
  egressGiBPerMonth: 0,
  storageGiB: 0,
};
const defaultIngress = { selector: { app: "demo" }, ports: [{ port: 80, targetPort: 80 }] };

describe("randomDnsRecordName", () => {
  it("produces a plausible-looking hostname", () => {
    expect(randomDnsRecordName()).toMatch(/^app-[a-z0-9]+\.example\.com$/);
  });

  it("produces different values across calls (random, not a fixed default)", () => {
    const names = new Set(Array.from({ length: 10 }, () => randomDnsRecordName()));
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("buildDnsInput", () => {
  it("returns undefined when both fields are blank", () => {
    expect(buildDnsInput("", "")).toBeUndefined();
  });

  it("returns undefined when only one field is filled in", () => {
    expect(buildDnsInput("api.example.com", "")).toBeUndefined();
    expect(buildDnsInput("", "Z0123456789ABCDEFGHIJ")).toBeUndefined();
  });

  it("returns the trimmed pair once both fields are filled in", () => {
    expect(buildDnsInput("  api.example.com  ", "  Z0123456789ABCDEFGHIJ  ")).toEqual({
      recordName: "api.example.com",
      route53ZoneId: "Z0123456789ABCDEFGHIJ",
    });
  });
});

describe("buildPlanRequestBody", () => {
  it("omits workload and ingress when the user never touched the advanced fields", () => {
    const body = buildPlanRequestBody({
      imageReference: "pending-build/app:latest",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress: defaultIngress,
      ingressTouched: false,
    });
    expect(body.workload).toBeUndefined();
    expect(body.ingress).toBeUndefined();
    // Image reference is always present in the request body — a real value
    // if the user set one, otherwise the auto-derived placeholder callers
    // pass in (see the Wizard component's handleSubmit).
    expect(body.image.reference).toBe("pending-build/app:latest");
  });

  it("includes workload once the user has touched the advanced fields", () => {
    const workload = { manifests: ["a.yaml"], replicasPerRegion: 3, requestsPerPod: { vcpu: 2, memGiB: 4 }, egressGiBPerMonth: 10, storageGiB: 5 };
    const body = buildPlanRequestBody({
      imageReference: "ghcr.io/acme/app:1.0",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload,
      workloadTouched: true,
      ingress: defaultIngress,
      ingressTouched: false,
    });
    expect(body.workload).toEqual(workload);
  });

  it("includes ingress once the user has touched the ingress fields, independent of workloadTouched", () => {
    const ingress = { selector: { app: "custom" }, ports: [{ port: 443, targetPort: 8443 }] };
    const body = buildPlanRequestBody({
      imageReference: "ghcr.io/acme/app:1.0",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress,
      ingressTouched: true,
    });
    expect(body.workload).toBeUndefined();
    expect(body.ingress).toEqual(ingress);
  });

  it("omits buildContextId when no folder was uploaded", () => {
    const body = buildPlanRequestBody({
      imageReference: "pending-build/app:latest",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress: defaultIngress,
      ingressTouched: false,
    });
    expect(body.image.buildContextId).toBeUndefined();
  });

  it("includes buildContextId once a folder has been uploaded", () => {
    const body = buildPlanRequestBody({
      imageReference: "pending-build/app:latest",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress: defaultIngress,
      ingressTouched: false,
      buildContextId: "abc-123",
    });
    expect(body.image.buildContextId).toBe("abc-123");
  });

  it("omits dns when no DNS input was built", () => {
    const body = buildPlanRequestBody({
      imageReference: "pending-build/app:latest",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress: defaultIngress,
      ingressTouched: false,
    });
    expect(body.dns).toBeUndefined();
  });

  it("includes dns once both fields were filled in", () => {
    const dns = { recordName: "api.example.com", route53ZoneId: "Z0123456789ABCDEFGHIJ" };
    const body = buildPlanRequestBody({
      imageReference: "pending-build/app:latest",
      platforms: ["linux/amd64"],
      targetGeoIds: ["eu-central"],
      workload: defaultWorkload,
      workloadTouched: false,
      ingress: defaultIngress,
      ingressTouched: false,
      dns,
    });
    expect(body.dns).toEqual(dns);
  });
});
