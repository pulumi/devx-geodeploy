// GCP Cloud Billing Catalog API. Requires an API key or OAuth (no public
// unauthenticated bulk equivalent exists, unlike AWS/Azure) — confirmed by a
// live, unauthenticated probe against cloudbilling.googleapis.com returning
// 403 PERMISSION_DENIED ("Method doesn't allow unregistered callers").
export const CLOUD_BILLING_BASE_URL = "https://cloudbilling.googleapis.com/v1";

// Confirmed against GCP documentation.
export const COMPUTE_ENGINE_SERVICE_ID = "6F81-5844-456A";

// NOT CONFIRMED. GKE bills its per-cluster management fee under its own
// Cloud Billing Catalog service id, separate from Compute Engine, but this
// session had no way to look it up: `cloudbilling.googleapis.com/v1/services`
// itself requires an API key (confirmed live, same 403), and web search did
// not turn up an authoritative, current value (only an unrelated
// documentation placeholder ID, which would be wrong to hardcode here).
// Treat this as a placeholder to replace with a value confirmed via either
// `gcloud billing services list` or an authenticated `GET .../v1/services`
// call once credentials are available — do not trust it for real pricing.
export const GKE_SERVICE_ID_UNCONFIRMED = "CCD8-9BF1-090E";

export function skusUrl(serviceId: string, pageToken?: string, apiKey?: string): string {
  const params = new URLSearchParams();
  if (apiKey) params.set("key", apiKey);
  if (pageToken) params.set("pageToken", pageToken);
  const qs = params.toString();
  return `${CLOUD_BILLING_BASE_URL}/services/${serviceId}/skus${qs ? `?${qs}` : ""}`;
}
