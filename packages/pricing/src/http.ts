// Minimal structural subset of the global `fetch` signature, so every
// adapter's live client accepts an injectable fetch implementation (real
// network by default, a stub in tests) without depending on DOM lib types.
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

export const defaultFetch: FetchLike = fetch as unknown as FetchLike;

export async function fetchJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
