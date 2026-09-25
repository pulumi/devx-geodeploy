// Parses the `--shape <N>vcpu-<M>gb` ad-hoc workload shape used by `geodeploy price`.
const SHAPE_PATTERN = /^(\d+(?:\.\d+)?)vcpu-(\d+(?:\.\d+)?)gb$/i;

export interface PodShape {
  vcpu: number;
  memGiB: number;
}

export function parseShape(shape: string): PodShape {
  const match = SHAPE_PATTERN.exec(shape.trim());
  if (!match) {
    throw new Error(`Invalid --shape "${shape}": expected the form "<N>vcpu-<M>gb", e.g. "4vcpu-16gb".`);
  }
  return { vcpu: Number(match[1]), memGiB: Number(match[2]) };
}
