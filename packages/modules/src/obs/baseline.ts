import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

export interface ObsK8sBaselineArgs {
  namespace?: pulumi.Input<string>;
  otelCollectorImage?: string;
  prometheusImage?: string;
}

export interface ObsK8sBaselineOutputs {
  namespace: kubernetes.core.v1.Namespace;
  daemonSet: kubernetes.apps.v1.DaemonSet;
}

/**
 * Module ID: `obs.k8s.baseline`
 *
 * Baseline observability: a Prometheus + OTel collector sidecar-per-node
 * daemonset, one pod per cluster node, scraping node/kubelet metrics and
 * forwarding OTLP.
 */
export function obsK8sBaseline(
  name: string,
  args: ObsK8sBaselineArgs,
  opts?: pulumi.ComponentResourceOptions,
): ObsK8sBaselineOutputs {
  const namespaceName = args.namespace ?? "geodeploy-observability";
  const namespace = new kubernetes.core.v1.Namespace(`${name}-ns`, { metadata: { name: namespaceName } }, opts);

  const labels = { app: `${name}-obs-baseline` };

  const daemonSet = new kubernetes.apps.v1.DaemonSet(
    name,
    {
      metadata: { namespace: namespace.metadata.name, name },
      spec: {
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: "otel-collector",
                image: args.otelCollectorImage ?? "otel/opentelemetry-collector-contrib:latest",
                ports: [{ containerPort: 4317, name: "otlp-grpc" }],
              },
              {
                name: "prometheus-node-exporter",
                image: args.prometheusImage ?? "prom/node-exporter:latest",
                ports: [{ containerPort: 9100, name: "metrics" }],
              },
            ],
          },
        },
      },
    },
    { ...opts, parent: opts?.parent ?? namespace },
  );

  return { namespace, daemonSet };
}
