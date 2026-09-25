import { describe, it, expect, beforeEach } from "vitest";
import type * as pulumi from "@pulumi/pulumi";
import type { RegionPlan, DnsPlan } from "@geodeploy/core";
import { installPulumiMocks, type RecordedResource } from "./test-utils/mocks.js";

const records: RecordedResource[] = [];
installPulumiMocks(records);

const { composeProgram } = await import("./compose.js");

/**
 * `program()` itself resolves as soon as the (synchronous) resource
 * construction calls return - the underlying `registerResource` RPCs (which
 * is where our mock's `newResource` actually runs) settle later, on their own
 * microtasks. Awaiting the program's own output values forces that whole
 * chain (cluster -> kubeconfig -> provider -> workload/ingress[-> dns]) to
 * fully settle before a test inspects the recorded resource graph.
 */
async function runAndSettle(program: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const outputs = await program();
  for (const value of Object.values(outputs)) {
    if (value && typeof (value as pulumi.Output<unknown>).apply === "function") {
      await new Promise<void>((resolve) => {
        (value as pulumi.Output<unknown>).apply((v) => {
          resolve();
          return v;
        });
      });
    }
  }
  return outputs;
}

function regionPlan(overrides: Partial<RegionPlan>): RegionPlan {
  return {
    geoId: "eu-central",
    provider: "aws",
    region: "us-east-1",
    sku: "t3.medium",
    centroid: { lat: 39.0438, lon: -77.4874 },
    demandCentroid: { lat: 50.1109, lon: 8.6821 },
    nodesNeeded: 2,
    monthlyUsd: 123.45,
    provisionable: true,
    modules: {
      cluster: "cluster.aws.eks",
      registry: "registry.aws.ecr",
      ingress: "ingress.public-alb",
      autoscaling: "autoscaling.none",
      sizing: "sizing.default",
    },
    ...overrides,
  };
}

const noDns: DnsPlan = { provider: null, reason: "no DNS provider detected" };

const baseConfig = {
  workloadManifestFiles: [] as string[],
  ingress: { selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] },
};

function byType(type: string): RecordedResource[] {
  return records.filter((r) => r.type === type);
}

describe("composeProgram", () => {
  beforeEach(() => {
    records.length = 0;
  });

  it("wires cluster -> kubeconfig -> kubernetes.Provider -> workload for an AWS region plan", async () => {
    const plan = regionPlan({ geoId: "aws-region", provider: "aws" });
    const program = composeProgram(plan, noDns, baseConfig);
    const outputs = await runAndSettle(program);

    // Cluster really was constructed (the eks remote component).
    const clusterResources = byType("eks:index:Cluster");
    expect(clusterResources).toHaveLength(1);

    // A kubernetes.Provider was constructed, and its kubeconfig input is
    // genuinely derived from *this* cluster's fabricated kubeconfig (not a
    // coincidental empty/default value) - the cluster -> kubeconfig edge.
    const k8sProviders = byType("pulumi:providers:kubernetes");
    expect(k8sProviders).toHaveLength(1);
    const providerKubeconfig = k8sProviders[0]!.inputs.kubeconfig as string;
    expect(providerKubeconfig).toContain(clusterResources[0]!.name);

    // The workload (ConfigGroup) and ingress (Service) were both bound to
    // *that exact* kubernetes.Provider instance, not the ambient default -
    // the kubeconfig -> kubernetes.Provider -> workload edge.
    const configGroups = byType("kubernetes:yaml/v2:ConfigGroup");
    const services = byType("kubernetes:core/v1:Service");
    expect(configGroups).toHaveLength(1);
    expect(services).toHaveLength(1);
    expect(configGroups[0]!.provider).toBeDefined();
    expect(configGroups[0]!.provider).toBe(services[0]!.provider);

    // no DNS wiring when dnsPlan.provider is null
    expect(byType("aws:route53/record:Record")).toHaveLength(0);
    expect("dnsRecordSetId" in outputs).toBe(false);

    // The decision engine's chosen sku/nodesNeeded actually reach the cluster
    // args, not just plan.json - this was previously silently dropped, so
    // every cluster got the module's hardcoded t3.medium/2 defaults
    // regardless of what the plan said.
    expect(clusterResources[0]!.inputs.instanceType).toBe(plan.sku);
    expect(clusterResources[0]!.inputs.desiredCapacity).toBe(plan.nodesNeeded);
    expect(clusterResources[0]!.inputs.minSize).toBe(1);
    expect(clusterResources[0]!.inputs.maxSize).toBe(3);

    // kubeconfig is exposed as a stack output (secret-wrapped) so
    // packages/observe can read it back via stack.outputs() without any
    // credential ever touching a JSON artifact on disk.
    expect(outputs.kubeconfig).toBeDefined();
  });

  it("wires cluster -> kubeconfig -> kubernetes.Provider -> workload for an Azure region plan", async () => {
    const plan = regionPlan({
      geoId: "azure-region",
      provider: "azure",
      region: "eastus",
      modules: {
        cluster: "cluster.azure.aks",
        registry: "registry.azure.acr",
        ingress: "ingress.public-alb",
        autoscaling: "autoscaling.none",
        sizing: "sizing.default",
      },
    });
    const program = composeProgram(plan, noDns, baseConfig);
    await runAndSettle(program);

    const managedClusters = byType("azure-native:containerservice:ManagedCluster");
    expect(managedClusters).toHaveLength(1);
    const k8sProviders = byType("pulumi:providers:kubernetes");
    expect(k8sProviders).toHaveLength(1);
    // AKS kubeconfig is base64-decoded from listManagedClusterUserCredentials.
    expect(k8sProviders[0]!.inputs.kubeconfig as string).toContain("apiVersion");

    const agentPool = (managedClusters[0]!.inputs.agentPoolProfiles as Array<{ vmSize: string; count: number }>)[0]!;
    expect(agentPool.vmSize).toBe(plan.sku);
    expect(agentPool.count).toBe(plan.nodesNeeded);

    const configGroups = byType("kubernetes:yaml/v2:ConfigGroup");
    expect(configGroups).toHaveLength(1);
    expect(configGroups[0]!.provider).toBeDefined();
  });

  it("wires cluster -> kubeconfig -> kubernetes.Provider -> workload for a GCP region plan", async () => {
    const plan = regionPlan({
      geoId: "gcp-region",
      provider: "gcp",
      region: "us-central1",
      modules: {
        cluster: "cluster.gcp.gke",
        registry: "registry.gcp.ar",
        ingress: "ingress.public-alb",
        autoscaling: "autoscaling.none",
        sizing: "sizing.default",
      },
    });
    const program = composeProgram(plan, noDns, baseConfig);
    await runAndSettle(program);

    const clusters = byType("gcp:container/cluster:Cluster");
    expect(clusters).toHaveLength(1);
    const k8sProviders = byType("pulumi:providers:kubernetes");
    expect(k8sProviders).toHaveLength(1);
    expect(k8sProviders[0]!.inputs.kubeconfig as string).toContain("34.1.2.3");

    expect(clusters[0]!.inputs.initialNodeCount).toBe(plan.nodesNeeded);
    expect((clusters[0]!.inputs.nodeConfig as { machineType: string }).machineType).toBe(plan.sku);

    const configGroups = byType("kubernetes:yaml/v2:ConfigGroup");
    expect(configGroups).toHaveLength(1);
    expect(configGroups[0]!.provider).toBeDefined();
  });

  it.each(["ingress.public-alb", "ingress.waf-fronted", "ingress.internal-only"])(
    "accepts the real ingress posture %s the decision engine actually produces, not just a module id",
    async (ingressPosture) => {
      // Regression test for a real bug found via the first real (non-fixture)
      // `geodeploy apply` run: compose.ts used to strictly require
      // RegionPlan.modules.ingress === "ingress.k8s.service-lb" (the
      // concrete module id), but the decision engine only ever produces one
      // of these three POSTURE ids (see questions.ts's INGRESS_OPTIONS /
      // fallback.ts's REGISTRY_DEFAULT_INGRESS) -- meaning every real apply
      // failed outright, 100% of the time, until this was fixed.
      const plan = regionPlan({ modules: { ...regionPlan({}).modules, ingress: ingressPosture } });
      const program = composeProgram(plan, noDns, baseConfig);
      await expect(runAndSettle(program)).resolves.toBeDefined();
    },
  );

  it("rejects an ingress value that isn't a recognized posture", async () => {
    const plan = regionPlan({ modules: { ...regionPlan({}).modules, ingress: "ingress.not-a-real-posture" } });
    const program = composeProgram(plan, noDns, baseConfig);
    await expect(program()).rejects.toThrow(/not a recognized ingress posture/);
  });

  it("rejects a plan whose module selection disagrees with its provider", async () => {
    const plan = regionPlan({
      provider: "aws",
      modules: {
        cluster: "cluster.azure.aks", // mismatched on purpose
        registry: "registry.aws.ecr",
        ingress: "ingress.public-alb",
        autoscaling: "autoscaling.none",
        sizing: "sizing.default",
      },
    });
    const program = composeProgram(plan, noDns, baseConfig);
    await expect(program()).rejects.toThrow(/does not match/);
  });

  it("mixed scenario: an AWS compute cluster with Cloudflare DNS - DNS selection is decoupled from compute provider", async () => {
    const plan = regionPlan({ geoId: "mixed-region", provider: "aws" });
    const dnsPlan: DnsPlan = { provider: "cloudflare", reason: "only Cloudflare credentials detected" };

    const program = composeProgram(plan, dnsPlan, {
      ...baseConfig,
      dns: {
        recordName: "api.geodeploy.example",
        routingPolicy: "latency",
        cloudflare: { zoneId: "zone-1", accountId: "acct-1" },
      },
    });
    const outputs = await runAndSettle(program);

    // Compute is genuinely AWS...
    expect(byType("eks:index:Cluster")).toHaveLength(1);
    expect(byType("azure-native:containerservice:ManagedCluster")).toHaveLength(0);
    expect(byType("gcp:container/cluster:Cluster")).toHaveLength(0);

    // ...while DNS is genuinely Cloudflare, wired to the AWS cluster's own
    // ingress endpoint as its pool origin - proving DNS backend choice is
    // independent of which cloud runs compute.
    const pools = byType("cloudflare:index/loadBalancerPool:LoadBalancerPool");
    const lbs = byType("cloudflare:index/loadBalancer:LoadBalancer");
    expect(pools).toHaveLength(1);
    expect(lbs).toHaveLength(1);
    expect((pools[0]!.inputs.origins as Array<{ address: string }>)[0]!.address).toBe("203.0.113.10");
    expect(byType("aws:route53/record:Record")).toHaveLength(0);
    expect(byType("ns1:index/record:Record")).toHaveLength(0);
    expect(typeof outputs.dnsRecordSetId).toBe("object"); // a pulumi Output
  });

  it("mixed scenario: a GCP compute cluster with NS1 DNS", async () => {
    const plan = regionPlan({
      geoId: "mixed-gcp-region",
      provider: "gcp",
      region: "us-central1",
      modules: {
        cluster: "cluster.gcp.gke",
        registry: "registry.gcp.ar",
        ingress: "ingress.public-alb",
        autoscaling: "autoscaling.none",
        sizing: "sizing.default",
      },
    });
    const dnsPlan: DnsPlan = { provider: "ns1", reason: "only NS1 credentials detected" };

    const program = composeProgram(plan, dnsPlan, {
      ...baseConfig,
      dns: { recordName: "api.geodeploy.example", routingPolicy: "geo", routingKey: "US", ns1: { zone: "example.com" } },
    });
    await runAndSettle(program);

    expect(byType("gcp:container/cluster:Cluster")).toHaveLength(1);
    expect(byType("ns1:index/record:Record")).toHaveLength(1);
    expect(byType("cloudflare:index/loadBalancer:LoadBalancer")).toHaveLength(0);
    expect(byType("aws:route53/record:Record")).toHaveLength(0);
  });
});
