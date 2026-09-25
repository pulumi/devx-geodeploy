# GeoDeploy

GeoDeploy works out where a container should run and what it will cost, then deploys it. You give it your users' locations and a container image, it picks the best AWS, Azure, or Google Cloud region for each location using [TypeSafe Jev](https://docs.typesafe.ai/introduction), and it provisions consistent Kubernetes environments with the [Pulumi Automation API](https://www.pulumi.com/automation/).

It's an example of an agentic infrastructure workflow where each system has one job:

| System | Job | Never does |
| --- | --- | --- |
| TypeScript app | Takes the request, fetches live pricing, does all the math | Make judgment calls |
| Jev | Decides which region wins and which modules to use | Do arithmetic, generate code, or invent region names |
| Pulumi | Provisions clusters, registries, workloads, and DNS | Decide anything |

Every Jev answer comes with a confidence score and is checked against a threshold. If an answer falls below its threshold, the API is unreachable, or `TYPESAFE_API_KEY` isn't set, GeoDeploy uses a deterministic fallback instead.

## Requirements

- Node.js 20.6 or later
- pnpm
- A [TypeSafe](https://docs.typesafe.ai/introduction) API key (optional: without it, GeoDeploy runs the deterministic fallback)
- Credentials for the clouds you want to deploy to, plus a [Pulumi Cloud](https://app.pulumi.com/) access token (needed only for `apply`, `destroy`, and `monitor`)

## Getting started

```bash
pnpm install
pnpm build
cp .env.example .env   # fill in only the values you need
```

Plan a deployment from the sample request:

```bash
node packages/cli/dist/index.js plan --request examples/sample-request.json --out ./out
node packages/cli/dist/index.js explain --plan ./out/plan.json
node packages/cli/dist/index.js ui --dir ./out
```

`plan` doesn't touch any cloud account. It fetches public pricing, ranks the candidate regions, and writes `plan.json` and `plan.md`.

## Commands

| Command | What it does |
| --- | --- |
| `plan` | Prices and ranks every target geo, then writes `plan.json` and `plan.md` |
| `price` | Prints a ranked price table for a single geo and workload shape |
| `explain` | Prints the decision reasoning for each geo in a `plan.json` |
| `apply` | Provisions a plan, one Pulumi stack per region. It refuses to run unless every required credential passes readiness checks |
| `destroy` | Tears down a plan, with the same readiness checks as `apply` |
| `monitor` | Self-driving mode: watches CPU utilization and asks Jev whether to scale or shift regions (`--mode approval-gated` or `autonomous`) |
| `apply-resize` | Applies the most recent resize that `monitor` suggested |
| `ui` | Serves a live web UI with the deployment on a globe |

Run any command with `--help` to see its options.

## Project layout

| Package | Purpose |
| --- | --- |
| `core` | Shared types |
| `geo` | Geo normalization and great-circle distance |
| `catalog` | Regions that offer managed Kubernetes on each cloud |
| `pricing` | Live pricing from the AWS Price List API, Azure Retail Prices API, and Google Cloud Billing Catalog |
| `cost` | Bin-packing, architecture filtering, and monthly cost |
| `decide` | Jev questions, confidence gates, weight profiles, and the deterministic fallback |
| `modules` | Typed Pulumi modules for EKS/AKS/GKE, ECR/ACR/Artifact Registry, ingress, DNS, and observability |
| `compose` | Builds a Pulumi program from the chosen modules |
| `provision` | Automation API stacks and credential readiness checks |
| `detect`, `observe` | Credential detection and utilization metrics |
| `report` | `plan.json` and `plan.md` output |
| `cli`, `web` | Command-line interface and web UI |

## Tests

```bash
pnpm test        # unit tests; no network or credentials needed
pnpm typecheck
pnpm test:live   # calls live pricing APIs
```

## Keeping secrets out of the repo

- Put credentials in `.env` (it's gitignored) or in your shell environment. Never put them in a request or config file.
- Run output (`plan.json`, `plan.md`, `apply.json`, `monitor.json`) includes account-specific details and is gitignored. Point `--out` at a directory outside the repo, or at `./out`, which is also ignored.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push and pull request, and fails if any tracked file matches `.gitignore`.

## License

[Apache 2.0](LICENSE)
