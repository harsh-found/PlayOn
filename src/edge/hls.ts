import { isSafeTargetUrl, parseHlsMasterPlaylist, sanitizeHeaderValue, type HlsProbeResult } from "../domain/m3u8";
import { extractForwardHeaders } from "../domain/streams";
import type { RequestBudget } from "./budget";
import type { DeadStreamTracker } from "./dead-streams";
import { StreamProxy } from "./proxy";

const MAX_HLS_INSPECT_BYTES = 512 * 1024, MAX_HLS_REDIRECTS = 3, DEFAULT_TIMEOUT_MS = 1_100, CACHE_TTL_MS = 180_000, MAX_CACHE_ENTRIES = 150;
export type { HlsProbeResult };

export class HlsInspector {
  private readonly cache = new Map<string, { result: HlsProbeResult; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<HlsProbeResult | null>>();

  async inspect(
    url: string, headers?: Record<string, string> | null, timeoutMs = DEFAULT_TIMEOUT_MS,
    allowedHosts?: string, budget?: RequestBudget, deadStreams?: DeadStreamTracker
  ): Promise<HlsProbeResult | null> {
    if (!isSafeTargetUrl(url, allowedHosts)) return null;
    const { referer: r, origin: o, ua: u } = extractForwardHeaders(headers ?? null);
    const cacheKey = r || o || u ? `${url}\0${r ?? ""}\0${o ?? ""}\0${u ?? ""}` : url;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); return cached.result; }
    const pending = this.inflight.get(cacheKey);
    if (pending) return pending;
    if (budget && !budget.tryAcquire("probe")) return null;

    const job = this.fetchAndParse(url, headers, timeoutMs, allowedHosts).then((result) => {
      if (result) {
        deadStreams?.recordSuccess(url);
        if (this.cache.size >= MAX_CACHE_ENTRIES) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
        this.cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      } else deadStreams?.recordFailure(url);
      return result;
    }).finally(() => { this.inflight.delete(cacheKey); });

    this.inflight.set(cacheKey, job);
    return job;
  }

  private async fetchAndParse(initialUrl: string, headers?: Record<string, string> | null, timeoutMs = DEFAULT_TIMEOUT_MS, allowedHosts?: string): Promise<HlsProbeResult | null> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), reqHeaders = new Headers();
    if (headers) for (const k in headers) { const c = sanitizeHeaderValue(headers[k]); if (c) reqHeaders.set(k, c); }
    try {
      const fetched = await StreamProxy.fetchSafeRedirects(initialUrl, "GET", reqHeaders, MAX_HLS_REDIRECTS, allowedHosts, controller.signal);
      if (!fetched.ok) return null;
      if (!fetched.response.ok) { await fetched.response.body?.cancel().catch(() => {}); return null; }
      const read = await StreamProxy.readBoundedText(fetched.response, MAX_HLS_INSPECT_BYTES);
      return read.ok ? parseHlsMasterPlaylist(read.text, fetched.finalUrl) : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
}
