#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { Provider } from "@geodeploy/core";
import { runApply } from "./applyCmd.js";
import { runDestroy } from "./destroyCmd.js";
import { formatExplain, runExplain } from "./explainCmd.js";
import { applyPendingResize, runMonitor } from "./monitorCmd.js";
import { runPlan } from "./planCmd.js";
import { runPrice } from "./priceCmd.js";
import { runUi } from "./uiCmd.js";

// Loads a .env file from the current working directory (e.g.
// TYPESAFE_API_KEY) into process.env, using Node's native loader (20.6+) so
// no extra dependency is needed. Silently a no-op when no .env is present —
// real environment variables (CI, shell exports) still work either way.
try {
  process.loadEnvFile();
} catch {
  // no .env file in cwd — fine
}

const ALL_PROVIDERS: readonly Provider[] = ["aws", "azure", "gcp"];

function parseProviderList(value: string): Provider[] {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!ALL_PROVIDERS.includes(item as Provider)) {
      throw new Error(`Unknown provider "${item}" in --allowed-providers; expected a subset of ${ALL_PROVIDERS.join(",")}`);
    }
  }
  return items as Provider[];
}

function fail(message: string): never {
  process.stderr.write(`geodeploy: ${message}\n`);
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("geodeploy").description("Cost-optimized, latency-aware multi-cloud Kubernetes placement.");

  program
    .command("plan")
    .description("Price and rank every target geo, run tier-1 readiness detection, and write plan.json/plan.md.")
    .requiredOption("--request <path>", "path to a DeploymentRequest JSON file")
    .option("--out <dir>", "output directory for plan.json/plan.md", process.cwd())
    .action(async (opts: { request: string; out: string }) => {
      try {
        const { plan, planJsonPath, planMdPath } = await runPlan({ requestPath: opts.request, outDir: opts.out });
        process.stdout.write(
          `Wrote ${planJsonPath} and ${planMdPath}\n` +
            `${plan.regions.length} region(s), total $${plan.totalMonthlyUsd.toFixed(2)}/mo, ` +
            `dns=${plan.dns.provider ?? "none"}, detected providers=${plan.detectedProviders.join(",") || "none"}\n`,
        );
        for (const note of plan.notes) {
          process.stdout.write(`note: ${note}\n`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  program
    .command("price")
    .description("Print a ranked, sourced, realism-tagged price table for one ad-hoc geo/shape.")
    .requiredOption("--geo <id>", "a known geo id (see @geodeploy/geo's normalizeGeo table)")
    .requiredOption("--shape <shape>", 'pod shape, e.g. "4vcpu-16gb"')
    .option("--allowed-providers <list>", "comma-separated subset of aws,azure,gcp")
    .action(async (opts: { geo: string; shape: string; allowedProviders?: string }) => {
      try {
        const { table } = await runPrice({
          geoId: opts.geo,
          shape: opts.shape,
          ...(opts.allowedProviders ? { allowedProviders: parseProviderList(opts.allowedProviders) } : {}),
        });
        process.stdout.write(table);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  program
    .command("explain")
    .description("Pretty-print a plan.json's full decision reasoning per geo.")
    .requiredOption("--plan <path>", "path to a previously written plan.json")
    .action(async (opts: { plan: string }) => {
      try {
        const { text } = await runExplain({ planPath: opts.plan });
        process.stdout.write(text);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  program
    .command("apply")
    .description("Provision a plan. Refuses cleanly (never touching Pulumi) unless every needed credential is ready.")
    .requiredOption("--plan <path>", "path to a previously written plan.json")
    .option("--config <path>", "path to a Record<geoId, ComposeConfig> JSON file")
    .option("--out <dir>", "output directory for apply.json", process.cwd())
    .action(async (opts: { plan: string; config?: string; out: string }) => {
      try {
        const result = await runApply({
          planPath: opts.plan,
          outDir: opts.out,
          ...(opts.config ? { configPath: opts.config } : {}),
        });
        process.stdout.write(`Wrote ${result.applyJsonPath}\n`);
        if (result.refused) {
          process.stderr.write("geodeploy apply: refused — not ready to provision:\n");
          for (const blocker of result.blockers) process.stderr.write(`  - ${blocker}\n`);
          process.exit(1);
        }
        process.stdout.write(`geodeploy apply: provisioned ${Object.keys(result.provisionResult!.results).length} region(s)\n`);
        for (const [geoId, outcome] of Object.entries(result.provisionResult!.results)) {
          process.stdout.write(`  ${geoId}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}\n`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  program
    .command("destroy")
    .description("Tear down a plan. Same readiness gating as apply; real teardown is deferred to the credential-gated tier.")
    .requiredOption("--plan <path>", "path to a previously written plan.json")
    .action(async (opts: { plan: string }) => {
      try {
        const result = await runDestroy({ planPath: opts.plan });
        process.stderr.write("geodeploy destroy: refused:\n");
        for (const blocker of result.blockers) process.stderr.write(`  - ${blocker}\n`);
        process.exit(1);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  const monitorCommand = program
    .command("monitor")
    .description(
      "Continuously observe live CPU utilization (Kubernetes Metrics API) and suggest/apply topology resizes via TypeSafe.",
    )
    .requiredOption("--plan <path>", "path to a previously written plan.json")
    .requiredOption("--config <path>", "path to a Record<geoId, ComposeConfig> JSON file")
    .option("--out <dir>", "output directory for monitor.json/apply.json", process.cwd())
    .option("--interval <ms>", "poll interval in milliseconds", String(5 * 60_000))
    .option("--mode <mode>", "approval-gated | autonomous", "approval-gated")
    .action(async (opts: { plan: string; config: string; out: string; interval: string; mode: string }) => {
      if (opts.mode !== "approval-gated" && opts.mode !== "autonomous") {
        fail(`--mode must be "approval-gated" or "autonomous", got "${opts.mode}"`);
      }
      try {
        const { monitorJsonPath, done } = await runMonitor({
          planPath: opts.plan,
          configPath: opts.config,
          outDir: opts.out,
          intervalMs: Number(opts.interval),
          mode: opts.mode as "approval-gated" | "autonomous",
        });
        process.stdout.write(
          `geodeploy monitor: writing ${monitorJsonPath} every ${opts.interval}ms (mode=${opts.mode}); Ctrl-C to stop\n`,
        );
        // Long-running: like `ui`, this runs until Ctrl-C (or, in tests,
        // until `maxIterations` is reached and `done` resolves on its own).
        await done;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  monitorCommand
    .command("apply-resize")
    .description("Apply the most recently suggested resize recorded in monitor.json (approval-gated mode's human trigger).")
    .requiredOption("--plan <path>", "path to plan.json (overwritten in place with the resized topology)")
    .requiredOption("--config <path>", "path to a Record<geoId, ComposeConfig> JSON file")
    .option("--out <dir>", "directory containing monitor.json; apply.json is written here too", process.cwd())
    .action(async (opts: { plan: string; config: string; out: string }) => {
      try {
        const result = await applyPendingResize({ planPath: opts.plan, monitorDir: opts.out, configPath: opts.config });
        process.stdout.write(`Wrote ${result.applyJsonPath}\n`);
        if (result.refused) {
          process.stderr.write("geodeploy monitor apply-resize: refused — not ready to provision:\n");
          for (const blocker of result.blockers) process.stderr.write(`  - ${blocker}\n`);
          process.exit(1);
        }
        process.stdout.write(
          `geodeploy monitor apply-resize: provisioned ${Object.keys(result.provisionResult!.results).length} region(s)\n`,
        );
        for (const [geoId, outcome] of Object.entries(result.provisionResult!.results)) {
          process.stdout.write(`  ${geoId}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}\n`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  program
    .command("ui")
    .description("Serve a live-updating web GUI for a plan.json/apply.json directory.")
    .option("--dir <dir>", "directory containing plan.json/apply.json", process.cwd())
    .option("--port <port>", "port to listen on", "4000")
    .action(async (opts: { dir: string; port: string }) => {
      try {
        const { url } = await runUi({ dir: opts.dir, port: Number(opts.port) });
        process.stdout.write(`geodeploy ui: serving ${opts.dir} at ${url}\n`);
        // Long-running: unlike the other commands, this one runs until
        // Ctrl-C — the active http.Server keeps the event loop alive.
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  return program;
}

export { formatExplain, runApply, runDestroy, runExplain, runPlan, runPrice, runUi };
export { applyPendingResize, runMonitor };

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildProgram().parseAsync(process.argv);
}
