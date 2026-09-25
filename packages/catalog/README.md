# @geodeploy/catalog

Per-provider catalogs of cloud regions that (a) exist, (b) offer a managed
Kubernetes service (EKS / AKS / GKE), and (c) are addressable by the
corresponding Pulumi provider.

## Status: static vendored snapshot

The region lists in `src/aws.ts`, `src/azure.ts`, and `src/gcp.ts` are a
**hand-curated, static snapshot**, current as of 2026-09-16. Per
`PROJECT-PLAN.md` §5.2, these lists are meant to be generated and periodically
regenerated from live enumeration APIs:

- AWS — `ec2:DescribeRegions` + EKS availability
- Azure — `az account list-locations` / ARM `Microsoft.ContainerService` locations
- GCP — `container.googleapis.com` locations list

None of those are callable in this environment (no cloud credentials are
configured anywhere here), so this pass hand-curates the data from public
provider documentation instead. When credentials become available, replace
the contents of these three files with the output of the (not-yet-written)
live enumerators; this snapshot should then become their recorded
fallback/fixture rather than the source of truth.

## API

- `awsCandidates()`, `azureCandidates()`, `gcpCandidates()` — per-provider `RegionCandidate[]`.
- `allCandidates()` — the concatenation of all three.

Every entry is validated against `RegionCandidateSchema` (from
`@geodeploy/core`) at module load time via `.parse()`, so a malformed entry
fails immediately rather than silently.
