import type { RegionCandidate } from "@geodeploy/core";
import { awsRegionCandidates } from "./aws.js";
import { azureRegionCandidates } from "./azure.js";
import { gcpRegionCandidates } from "./gcp.js";

export { awsRegionCandidates } from "./aws.js";
export { azureRegionCandidates } from "./azure.js";
export { gcpRegionCandidates } from "./gcp.js";

/** All AWS region candidates that offer EKS (static vendored snapshot). */
export function awsCandidates(): RegionCandidate[] {
  return awsRegionCandidates;
}

/** All Azure region candidates that offer AKS (static vendored snapshot). */
export function azureCandidates(): RegionCandidate[] {
  return azureRegionCandidates;
}

/** All GCP region candidates that offer GKE (static vendored snapshot). */
export function gcpCandidates(): RegionCandidate[] {
  return gcpRegionCandidates;
}

/** All region candidates across AWS, Azure, and GCP (static vendored snapshot). */
export function allCandidates(): RegionCandidate[] {
  return [...awsRegionCandidates, ...azureRegionCandidates, ...gcpRegionCandidates];
}
