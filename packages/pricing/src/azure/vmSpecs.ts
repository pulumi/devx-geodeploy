import type { Arch } from "@geodeploy/core";

// The Retail Prices API returns price, not shape — no vcpu/memory/architecture
// fields. Azure also doesn't publish those as a queryable API; they're a
// vendored fact, exactly like `packages/catalog`'s seed data. This is a small,
// explicit, testable table (not regex guessing) for the SKUs this adapter
// supports. "Dpsv5"/"Dplsv5"/"Epsv5"-family names ("p" = Cobalt/Ampere Arm)
// are Azure's arm64 general-purpose line; everything else here is x86_64.
export interface AzureVmSpec {
  vcpu: number;
  memGiB: number;
  arch: Arch;
}

export const AZURE_VM_SPECS: Record<string, AzureVmSpec> = {
  Standard_D2s_v5: { vcpu: 2, memGiB: 8, arch: "x86_64" },
  Standard_D4s_v5: { vcpu: 4, memGiB: 16, arch: "x86_64" },
  Standard_D8s_v5: { vcpu: 8, memGiB: 32, arch: "x86_64" },
  Standard_D2ps_v5: { vcpu: 2, memGiB: 8, arch: "arm64" },
  Standard_D4ps_v5: { vcpu: 4, memGiB: 16, arch: "arm64" },
  Standard_D8ps_v5: { vcpu: 8, memGiB: 32, arch: "arm64" },
};

export function lookupAzureVmSpec(armSkuName: string): AzureVmSpec | undefined {
  return AZURE_VM_SPECS[armSkuName];
}
