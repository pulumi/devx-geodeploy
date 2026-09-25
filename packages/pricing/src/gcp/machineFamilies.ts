import type { Arch } from "@geodeploy/core";

// GCP's SKU descriptions are free text ("N2 Predefined Instance Core running
// in Americas"); this is the explicit, tested mapping from a SKU's structured
// `category.resourceGroup` to the machine family's architecture and the
// description-text label used to tell its "Core" (vCPU) SKU apart from its
// "Ram" (memory) SKU — not regex guessing over the description.
export interface MachineFamilyDescriptor {
  arch: Arch;
  /** Text every SKU description for this family starts with, e.g. "N2 Predefined". */
  descriptionLabel: string;
}

export const MACHINE_FAMILIES: Record<string, MachineFamilyDescriptor> = {
  N1: { arch: "x86_64", descriptionLabel: "N1 Predefined" },
  N2: { arch: "x86_64", descriptionLabel: "N2 Predefined" },
  N2D: { arch: "x86_64", descriptionLabel: "N2D AMD Predefined" },
  E2: { arch: "x86_64", descriptionLabel: "E2 Predefined" },
  // Tau T2A: GCP's Ampere Altra Arm-based family — the one arm64 machine
  // family in the Compute Engine catalog today.
  T2A: { arch: "arm64", descriptionLabel: "Tau T2A" },
};

export function isCoreDescription(family: MachineFamilyDescriptor, description: string): boolean {
  return description.startsWith(family.descriptionLabel) && description.includes("Instance Core");
}

export function isRamDescription(family: MachineFamilyDescriptor, description: string): boolean {
  return description.startsWith(family.descriptionLabel) && description.includes("Instance Ram");
}

export interface GcpMachineTypeSpec {
  vcpu: number;
  memGiB: number;
  arch: Arch;
  /** category.resourceGroup for the SKUs pricing this machine type's family. */
  resourceGroup: string;
}

// Vendored machine-type shapes (GCP does not expose vcpu/memory via the
// billing API either — same reasoning as `azure/vmSpecs.ts`). Pricing is
// rate-based (per-vCPU-hour * vcpu + per-GiB-hour * memGiB, see
// `findNodeFacts` in parser.ts), so adding a larger shape here needs no new
// fixture data — it's priced from the same Core/Ram SKUs as the smaller
// sizes. The 8vcpu/32GiB entries exist because packages/cost's 10% node
// headroom means a shortlist topping out at 4vcpu/16GiB can never actually
// host a 4vcpu-16gb pod (confirmed live: this silently dropped every GCP
// candidate for this project's own example `price` command).
export const GCP_MACHINE_TYPES: Record<string, GcpMachineTypeSpec> = {
  "n2-standard-2": { vcpu: 2, memGiB: 8, arch: "x86_64", resourceGroup: "N2" },
  "n2-standard-4": { vcpu: 4, memGiB: 16, arch: "x86_64", resourceGroup: "N2" },
  "n2-standard-8": { vcpu: 8, memGiB: 32, arch: "x86_64", resourceGroup: "N2" },
  "t2a-standard-2": { vcpu: 2, memGiB: 8, arch: "arm64", resourceGroup: "T2A" },
  "t2a-standard-4": { vcpu: 4, memGiB: 16, arch: "arm64", resourceGroup: "T2A" },
  "t2a-standard-8": { vcpu: 8, memGiB: 32, arch: "arm64", resourceGroup: "T2A" },
};

export function lookupGcpMachineType(machineType: string): GcpMachineTypeSpec | undefined {
  return GCP_MACHINE_TYPES[machineType];
}
