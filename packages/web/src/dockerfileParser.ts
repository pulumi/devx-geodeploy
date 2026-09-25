// Best-effort, purely-textual Dockerfile scanning — no BuildKit/Docker
// involved. Used by the wizard's drag-and-drop zone to pre-fill (never lock)
// the platforms checkboxes and to show the user what base images a dropped
// Dockerfile references.
//
// What this deliberately does NOT do: infer the image reference the wizard's
// "Image reference" field needs. A Dockerfile never says where the built
// image gets pushed (registry/repo/tag) — that's decided by CI, not the
// Dockerfile — so callers must always ask the user for that separately.
export interface DockerfileHints {
  /** e.g. ["linux/amd64", "linux/arm64"] — best-effort inference, never empty. */
  platforms: string[];
  /** Every FROM line's image reference, in order (informational only). */
  baseImages: string[];
}

// Docker's own case-insensitive keywords: `FROM ... [AS name]`.
const FROM_LINE = /^\s*FROM\s+(.+?)\s*$/i;
const AS_CLAUSE = /\s+AS\s+\S+\s*$/i;
// Docker's real, documented syntax for pinning a build stage's platform:
// `FROM --platform=<value> <image> [AS <name>]`.
const PLATFORM_FLAG = /--platform=(\S+)/i;

export function parseDockerfile(text: string): DockerfileHints {
  const baseImages: string[] = [];
  const platforms: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const fromMatch = FROM_LINE.exec(line);
    if (!fromMatch) continue;

    let rest = fromMatch[1] ?? "";

    const platformMatch = PLATFORM_FLAG.exec(rest);
    if (platformMatch) {
      const platform = platformMatch[1] ?? "";
      if (platform.length > 0 && !platforms.includes(platform)) platforms.push(platform);
      rest = rest.replace(PLATFORM_FLAG, "").trim();
    }

    // Strip a trailing " AS <name>" stage alias, leaving the bare image ref.
    rest = rest.replace(AS_CLAUSE, "").trim();

    if (rest.length > 0) baseImages.push(rest);
  }

  // No explicit --platform pin anywhere doesn't mean single-arch — it just
  // means the Dockerfile doesn't say, so default to this project's own
  // two-platform convention (examples/sample-request.json) rather than
  // under-claiming with an empty list.
  if (platforms.length === 0) {
    platforms.push("linux/amd64", "linux/arm64");
  }

  return { platforms, baseImages };
}
