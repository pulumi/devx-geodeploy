import { describe, expect, it } from "vitest";
import { computeMonthlyCost, nodesNeeded, podsPerNode } from "./tco.js";

describe("podsPerNode", () => {
  it("bounds density by whichever of vcpu/mem runs out first", () => {
    // node: 4 vcpu / 8 GiB, 10% headroom -> usable 3.6 vcpu / 7.2 GiB
    // pod: 0.5 vcpu / 1 GiB -> byVcpu = floor(3.6/0.5) = 7, byMem = floor(7.2/1) = 7
    expect(podsPerNode({ vcpu: 4, memGiB: 8 }, { vcpu: 0.5, memGiB: 1 })).toBe(7);
  });

  it("returns 0 when a pod request is larger than the node can ever fit", () => {
    expect(podsPerNode({ vcpu: 1, memGiB: 1 }, { vcpu: 2, memGiB: 2 })).toBe(0);
  });
});

describe("nodesNeeded", () => {
  it("needs exactly one node when replicas fit within one node's density", () => {
    // density = 7 (see podsPerNode test above), 4 replicas fit in 1 node
    expect(nodesNeeded(4, { vcpu: 4, memGiB: 8 }, { vcpu: 0.5, memGiB: 1 })).toBe(1);
  });

  it("needs multiple nodes when replicas exceed one node's density", () => {
    // density = 7, 20 replicas -> ceil(20/7) = 3
    expect(nodesNeeded(20, { vcpu: 4, memGiB: 8 }, { vcpu: 0.5, memGiB: 1 })).toBe(3);
  });

  it("returns Infinity rather than dividing by zero when no pod fits", () => {
    expect(nodesNeeded(4, { vcpu: 1, memGiB: 1 }, { vcpu: 2, memGiB: 2 })).toBe(Infinity);
  });
});

describe("computeMonthlyCost", () => {
  it("matches a hand-computed monthly bill", () => {
    const { breakdown, monthlyUsd } = computeMonthlyCost({
      nodesNeeded: 2,
      nodeUsdPerHour: 0.1,
      controlPlaneUsdPerHour: 0.1,
      egressGiBPerMonth: 100,
      egressUsdPerGiB: 0.09,
      storageGiB: 50,
      blockStorageUsdPerGiBMonth: 0.08,
      loadBalancerUsdPerHour: 0.025,
    });

    // computeUsd = 2 * 0.1 * 730 = 146
    // controlPlaneUsd = 0.1 * 730 = 73
    // egressUsd = 100 * 0.09 = 9
    // storageUsd = 50 * 0.08 = 4
    // lbUsd = 0.025 * 730 = 18.25
    // monthlyUsd = 146 + 73 + 9 + 4 + 18.25 = 250.25
    expect(breakdown).toEqual({
      computeUsd: 146,
      controlPlaneUsd: 73,
      egressUsd: 9,
      storageUsd: 4,
      lbUsd: 18.25,
    });
    expect(monthlyUsd).toBeCloseTo(250.25, 6);
  });
});
