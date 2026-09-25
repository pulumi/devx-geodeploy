import type { PriceQuote, WorkloadSpec } from "@geodeploy/core";
import { describe, expect, it } from "vitest";
import { pickCheapestSku } from "./binpack.js";
import { NODE_HEADROOM_FACTOR, nodesNeeded, podsPerNode } from "./tco.js";

function makeQuote(overrides: Partial<PriceQuote> & Pick<PriceQuote, "sku" | "vcpu" | "memGiB" | "arch" | "nodeUsdPerHour">): PriceQuote {
  return {
    provider: "aws",
    region: "us-east-1",
    controlPlaneUsdPerHour: 0.1,
    egressUsdPerGiB: 0.09,
    blockStorageUsdPerGiBMonth: 0.08,
    loadBalancerUsdPerHour: 0.025,
    currency: "USD",
    asOf: "2026-01-01T00:00:00Z",
    realism: "fixture",
    source: "test-fixture",
    ...overrides,
  };
}

function makeWorkload(overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return {
    manifests: ["deployment.yaml"],
    replicasPerRegion: 4,
    requestsPerPod: { vcpu: 0.5, memGiB: 1 },
    egressGiBPerMonth: 10,
    storageGiB: 20,
    ...overrides,
  };
}

describe("pickCheapestSku", () => {
  it("picks the single SKU when one node suffices", () => {
    const workload = makeWorkload({ replicasPerRegion: 4 });
    const quote = makeQuote({ sku: "m1", vcpu: 4, memGiB: 8, arch: "x86_64", nodeUsdPerHour: 0.1 });

    const result = pickCheapestSku(workload, [quote]);

    expect(result).toBeDefined();
    expect(result?.nodesNeeded).toBe(1);
    // computeUsd = 1*0.1*730=73, controlPlane=73, egress=10*0.09=0.9, storage=20*0.08=1.6, lb=0.025*730=18.25
    expect(result?.monthlyUsd).toBeCloseTo(166.75, 6);
  });

  it("needs multiple nodes when replicas exceed one node's capacity", () => {
    const workload = makeWorkload({ replicasPerRegion: 20 });
    const quote = makeQuote({ sku: "m1", vcpu: 4, memGiB: 8, arch: "x86_64", nodeUsdPerHour: 0.1 });

    const result = pickCheapestSku(workload, [quote]);

    // density = 7 -> ceil(20/7) = 3 nodes
    expect(result?.nodesNeeded).toBe(3);
    // computeUsd = 3*0.1*730=219, + 73 + 0.9 + 1.6 + 18.25 = 312.75
    expect(result?.monthlyUsd).toBeCloseTo(312.75, 6);
  });

  it("picks a cheaper arm64 SKU over a same-shape, pricier x86_64 SKU", () => {
    const workload = makeWorkload({ replicasPerRegion: 10, requestsPerPod: { vcpu: 1, memGiB: 2 } });
    const x86 = makeQuote({ sku: "x86-8-16", vcpu: 8, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.384 });
    const arm = makeQuote({ sku: "arm-8-16", vcpu: 8, memGiB: 16, arch: "arm64", nodeUsdPerHour: 0.3072 });

    const result = pickCheapestSku(workload, [x86, arm]);

    expect(result?.quote.arch).toBe("arm64");
    expect(result?.quote.sku).toBe("arm-8-16");
    expect(result?.nodesNeeded).toBe(2);
    // arm64 computeUsd = 2*0.3072*730 = 448.512, + 73 + 0.9 + 1.6 + 18.25 = 542.262
    expect(result?.monthlyUsd).toBeCloseTo(542.262, 6);
    // sanity: the x86_64 alternative would have been strictly more expensive
    // (2*0.384*730 = 560.64 + same extras = 654.39)
    expect(result!.monthlyUsd).toBeLessThan(654.39);
  });

  it("egress cost dominates total monthly cost for a high-egress workload", () => {
    const workload = makeWorkload({ replicasPerRegion: 4, egressGiBPerMonth: 100_000, storageGiB: 10 });
    const quote = makeQuote({ sku: "m1", vcpu: 4, memGiB: 8, arch: "x86_64", nodeUsdPerHour: 0.1 });

    const result = pickCheapestSku(workload, [quote]);
    expect(result).toBeDefined();

    // computeUsd=73, controlPlane=73, egress=100000*0.09=9000, storage=0.8, lb=18.25
    expect(result?.breakdown.egressUsd).toBeCloseTo(9000, 6);
    expect(result?.monthlyUsd).toBeCloseTo(9165.05, 6);
    // egress alone accounts for the overwhelming majority of the bill
    const nonEgress = result!.monthlyUsd - result!.breakdown.egressUsd;
    expect(result!.breakdown.egressUsd).toBeGreaterThan(nonEgress * 20);
  });

  it("does not pick a SKU that is cheap per-vcpu but memory-constrained over a balanced SKU", () => {
    const workload = makeWorkload({ replicasPerRegion: 10, requestsPerPod: { vcpu: 1, memGiB: 4 } });

    // Cheap per vcpu (0.15/16 = 0.009375 $/vcpu-hr) but memory-bound:
    // usable vcpu = 14.4 -> byVcpu = 14; usable mem = 14.4 -> byMem = floor(14.4/4) = 3
    // density = 3 (memory-bound) -> nodesNeeded = ceil(10/3) = 4
    const cheapPerVcpuButMemBound = makeQuote({ sku: "cheap-per-vcpu", vcpu: 16, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.15 });

    // Pricier per vcpu (0.22/8 = 0.0275 $/vcpu-hr) but balanced:
    // usable vcpu = 7.2 -> byVcpu = 7; usable mem = 28.8 -> byMem = floor(28.8/4) = 7
    // density = 7 -> nodesNeeded = ceil(10/7) = 2
    const balanced = makeQuote({ sku: "balanced", vcpu: 8, memGiB: 32, arch: "x86_64", nodeUsdPerHour: 0.22 });

    // Confirm the memory constraint is really what bounds the first SKU
    // (a naive vcpu-only calc would have said 14 pods/node -> 1 node).
    expect(podsPerNode({ vcpu: 16, memGiB: 16 }, { vcpu: 1, memGiB: 4 })).toBe(3);
    expect(nodesNeeded(10, { vcpu: 16, memGiB: 16 }, { vcpu: 1, memGiB: 4 })).toBe(4);

    const result = pickCheapestSku(workload, [cheapPerVcpuButMemBound, balanced]);

    expect(result?.quote.sku).toBe("balanced");
    expect(result?.nodesNeeded).toBe(2);
    // balanced total = 2*0.22*730 + 73 + 0.9 + 1.6 + 18.25 = 321.2 + 93.75 = 414.95
    expect(result?.monthlyUsd).toBeCloseTo(414.95, 6);
    // the memory-bound SKU's true (4-node) total would have been pricier
    // 4*0.15*730 + 93.75 = 438 + 93.75 = 531.75
    expect(result!.monthlyUsd).toBeLessThan(531.75);
  });

  it("returns undefined when no SKU can host even one pod", () => {
    const workload = makeWorkload({ requestsPerPod: { vcpu: 100, memGiB: 100 } });
    const quote = makeQuote({ sku: "tiny", vcpu: 2, memGiB: 4, arch: "x86_64", nodeUsdPerHour: 0.05 });

    expect(pickCheapestSku(workload, [quote])).toBeUndefined();
  });

  it("excludes an architecture the image was never built for, even when it's cheaper", () => {
    const workload = makeWorkload({ replicasPerRegion: 10, requestsPerPod: { vcpu: 1, memGiB: 2 } });
    const cheaperArm = makeQuote({ sku: "arm-8-16", vcpu: 8, memGiB: 16, arch: "arm64", nodeUsdPerHour: 0.3072 });
    const pricierX86 = makeQuote({ sku: "x86-8-16", vcpu: 8, memGiB: 16, arch: "x86_64", nodeUsdPerHour: 0.384 });

    // Unfiltered: arm64 wins on price, exactly like the no-filter test above.
    expect(pickCheapestSku(workload, [cheaperArm, pricierX86])?.quote.arch).toBe("arm64");

    // An image built only for linux/amd64 cannot run on the arm64 node at
    // all — this must exclude it outright, not just deprioritize it.
    const result = pickCheapestSku(workload, [cheaperArm, pricierX86], NODE_HEADROOM_FACTOR, ["x86_64"]);
    expect(result?.quote.arch).toBe("x86_64");
    expect(result?.quote.sku).toBe("x86-8-16");
  });

  it("returns undefined when every SKU is an incompatible architecture", () => {
    const workload = makeWorkload();
    const armOnly = makeQuote({ sku: "arm-only", vcpu: 4, memGiB: 8, arch: "arm64", nodeUsdPerHour: 0.1 });

    expect(pickCheapestSku(workload, [armOnly], NODE_HEADROOM_FACTOR, ["x86_64"])).toBeUndefined();
  });
});
