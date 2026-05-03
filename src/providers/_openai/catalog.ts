/**
 * GET /v1/models against an OpenAI-compatible catalog. Returns the raw items
 * as parsed from `data: [...]`. Providers do their own filtering / shaping
 * (e.g. cerebras keeps `owned_by`; openrouter has rich metadata).
 */
export interface FetchOpenAiCatalogOptions {
  url: string;
  headers: Record<string, string>;
  providerName: string;
}

export async function fetchOpenAiCatalog(opts: FetchOpenAiCatalogOptions): Promise<unknown[]> {
  const res = await fetch(opts.url, { headers: opts.headers });
  if (!res.ok) {
    throw new Error(`${opts.providerName} API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as any;
  return Array.isArray(data?.data) ? data.data : [];
}
