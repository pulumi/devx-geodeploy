import type { Arch } from "@geodeploy/core";

const PLATFORM_TO_ARCH: Record<string, Arch> = {
  "linux/amd64": "x86_64",
  "linux/arm64": "arm64",
};

/**
 * Maps Docker platform strings (e.g. `image.platforms` on a `DeploymentRequest`,
 * such as "linux/amd64"/"linux/arm64") to the `Arch` values `PriceQuote`/
 * `CandidateCost` use. An unrecognized platform string is dropped rather than
 * guessed — it simply contributes no allowed architecture.
 */
export function platformsToArches(platforms: readonly string[]): Arch[] {
  const arches = new Set<Arch>();
  for (const platform of platforms) {
    const arch = PLATFORM_TO_ARCH[platform];
    if (arch) arches.add(arch);
  }
  return [...arches];
}
