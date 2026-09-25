import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

export interface IngressK8sServiceLbArgs {
  selector: Record<string, pulumi.Input<string>>;
  ports: Array<{ name?: string; port: number; targetPort: number | string; protocol?: "TCP" | "UDP" }>;
  namespace?: pulumi.Input<string>;
}

export interface IngressK8sServiceLbOutputs {
  service: kubernetes.core.v1.Service;
  /**
   * Resolves once the cloud load balancer has an external address — Pulumi's
   * Kubernetes provider blocks `Service` `type=LoadBalancer` completion on
   * `status.loadBalancer.ingress` being populated, so this output doubles as
   * the readiness gate for anything depending on it (e.g. DNS wiring).
   */
  externalEndpoint: pulumi.Output<string>;
}

/**
 * Module ID: `ingress.k8s.service-lb`
 */
export function ingressK8sServiceLb(
  name: string,
  args: IngressK8sServiceLbArgs,
  opts?: pulumi.ComponentResourceOptions,
): IngressK8sServiceLbOutputs {
  const service = new kubernetes.core.v1.Service(
    name,
    {
      metadata: { namespace: args.namespace },
      spec: {
        type: "LoadBalancer",
        selector: args.selector,
        ports: args.ports,
      },
    },
    opts,
  );

  const externalEndpoint = service.status.apply((status) => {
    const ingress = status.loadBalancer.ingress[0];
    return ingress?.hostname || ingress?.ip || "";
  });

  return { service, externalEndpoint };
}
