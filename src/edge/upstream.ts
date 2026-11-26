import {
  decodeCncPayloadData, decodeCncRawId, MAX_CNC_RAW_ID_LENGTH,
  validateUpstreamMetasWithAudit, validateUpstreamStreams,
} from "../domain/cnc";
import { API_VERSION, SERVICE_NAME, type UpstreamStream } from "../types";
import type { RequestBudget } from "./budget";

export {
  decodeCncPayloadData, decodeCncRawId, MAX_CNC_RAW_ID_LENGTH,
  validateUpstreamMetasWithAudit, validateUpstreamStreams,
};

export const DEFAULT_UPSTREAM_HOSTS = ["https://cncverse.dpdns.org"] as const;

const STREAM_CACHE_TTL_MS = 25_000;
const STREAM_CACHE_MAX_ENTRIES = 250;
const CB_FAILURE_THRESHOLD = 3;
const CB_COOLDOWN_MS = 30_000;
const FETCH_TIMEOUT_MS = 6_500;
const STREAM_FETCH_TIMEOUT_MS = 10_000;
const SPECULATIVE_HEDGE_DELAY_MS = 650;

export interface HostBreakerState {
  host: string; state: "closed" | "open" | "half-open"; failures: number; openedAt: number; probeInFlight: boolean;
}
interface StreamCacheEntry { streams: UpstreamStream[]; expiresAt: number; }

export async function mapWithConcurrency<T, R>(items: ReadonlyArray<T>, limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item !== undefined) results[idx] = await worker(item, idx);
    }
  }));
  return results;
}

export class UpstreamClient {
  private readonly hosts: ReadonlyArray<string>;
  private readonly breakers = new Map<string, HostBreakerState>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly streamCache = new Map<string, StreamCacheEntry>();

  constructor(hosts: ReadonlyArray<string> = DEFAULT_UPSTREAM_HOSTS) {
    this.hosts = hosts.length ? hosts : DEFAULT_UPSTREAM_HOSTS;
    for (const host of this.hosts) this.breakers.set(host, { host, state: "closed", failures: 0, openedAt: 0, probeInFlight: false });
  }

  getHostHealth(): Array<{ host: string; state: "closed" | "open" | "half-open"; failures: number }> {
    const now = Date.now();
    return this.hosts.map((host) => {
      const b = this.breakers.get(host);
      return !b ? { host, state: "closed", failures: 0 } : { host, state: b.state === "open" && now - b.openedAt >= CB_COOLDOWN_MS ? "half-open" : b.state, failures: b.failures };
    });
  }

  private isOpen(host: string): boolean {
    const b = this.breakers.get(host);
    return Boolean(b && b.state === "open" && Date.now() - b.openedAt < CB_COOLDOWN_MS);
  }

  private async fetchFromHost(host: string, path: string, signal: AbortSignal, budget?: RequestBudget, kind: "critical" | "hedge" = "critical", timeoutMs = FETCH_TIMEOUT_MS, tripOnTimeout = true): Promise<unknown> {
    const b = this.breakers.get(host);
    let isProbe = false, timedOut = false;
    if (b && b.state !== "closed") {
      if (b.state === "open") {
        if (Date.now() - b.openedAt < CB_COOLDOWN_MS) throw new Error(`Circuit open for ${host}`);
        b.state = "half-open"; b.probeInFlight = true; isProbe = true;
      } else if (b.probeInFlight) throw new Error(`Circuit open for ${host}`);
      else { b.probeInFlight = true; isProbe = true; }
    }
    if (budget && !budget.tryAcquire(kind)) {
      if (isProbe && b) b.probeInFlight = false;
      throw new Error("Request subrequest budget exceeded");
    }
    const tc = new AbortController(), timer = setTimeout(() => { timedOut = true; tc.abort(); }, timeoutMs), onAbort = () => tc.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${host}${path}`, { method: "GET", headers: { Accept: "application/json", "User-Agent": `${SERVICE_NAME}/${API_VERSION}` }, signal: tc.signal });
      if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`Upstream HTTP ${res.status}`); }
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ct.includes("text/html") || ct.includes("application/xhtml")) { await res.body?.cancel().catch(() => {}); throw new Error(`Upstream HTML (${ct})`); }
      const trimmed = (await res.text()).trimStart();
      if (!trimmed || trimmed.charCodeAt(0) === 60) throw new Error("Upstream empty or HTML");
      const data: unknown = JSON.parse(trimmed);
      if (!data || typeof data !== "object") throw new Error("Upstream JSON root invalid");
      if (b) { b.state = "closed"; b.failures = 0; b.openedAt = 0; b.probeInFlight = false; }
      return data;
    } catch (err) {
      if (!signal.aborted && b) {
        b.probeInFlight = false;
        if ((tripOnTimeout || !timedOut) && (isProbe || ++b.failures >= CB_FAILURE_THRESHOLD)) { b.state = "open"; b.openedAt = Date.now(); }
      }
      throw err;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }

  async fetchJson(path: string, budget?: RequestBudget, timeoutMs = FETCH_TIMEOUT_MS, tripOnTimeout = true): Promise<unknown> {
    const key = `json:${path}`, existing = this.inflight.get(key);
    if (existing) return existing;
    const job = (async () => {
      const [primary, secondary] = [...this.hosts].sort((a, b) => (this.isOpen(a) ? 1 : 0) - (this.isOpen(b) ? 1 : 0));
      if (!primary) throw new Error("No upstream hosts configured");
      if (!secondary || this.isOpen(secondary)) return this.fetchFromHost(primary, path, new AbortController().signal, budget, "critical", timeoutMs, tripOnTimeout);
      const c1 = new AbortController(), c2 = new AbortController();
      return new Promise<unknown>((resolve, reject) => {
        let settled = false, failed = 0, secStarted = false, lastErr: unknown = new Error("All upstream hosts failed");
        const win = (d: unknown, p: boolean) => { if (!settled) { settled = true; clearTimeout(t); (p ? c2 : c1).abort(); resolve(d); } };
        const fail = (e: unknown) => { lastErr = e; if (++failed >= 2 && !settled) { settled = true; clearTimeout(t); reject(lastErr); } };
        const startSec = (kind: "critical" | "hedge") => {
          if (secStarted || settled) return;
          if (kind === "hedge" && budget && !budget.canAcquire("hedge")) return;
          secStarted = true;
          this.fetchFromHost(secondary, path, c2.signal, budget, kind, timeoutMs, tripOnTimeout).then((d) => win(d, false), fail);
        };
        const t = setTimeout(() => startSec("hedge"), SPECULATIVE_HEDGE_DELAY_MS);
        this.fetchFromHost(primary, path, c1.signal, budget, "critical", timeoutMs, tripOnTimeout).then((d) => win(d, true), (e) => { fail(e); startSec("critical"); });
      });
    })().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, job);
    return job;
  }

  async fetchCatalog(providerKey: string, catalogId: string, budget?: RequestBudget) {
    return validateUpstreamMetasWithAudit(providerKey, await this.fetchJson(`/catalog/tv/${encodeURIComponent(catalogId)}.json`, budget));
  }

  async fetchStreams(rawId: string, budget?: RequestBudget): Promise<UpstreamStream[]> {
    const cached = this.streamCache.get(rawId);
    if (cached && cached.expiresAt > Date.now()) { this.streamCache.delete(rawId); this.streamCache.set(rawId, cached); return cached.streams; }
    const streams = validateUpstreamStreams(await this.fetchJson(`/stream/tv/${encodeURIComponent(rawId)}.json`, budget, STREAM_FETCH_TIMEOUT_MS, false));
    if (this.streamCache.size >= STREAM_CACHE_MAX_ENTRIES) { const oldest = this.streamCache.keys().next().value; if (oldest !== undefined) this.streamCache.delete(oldest); }
    this.streamCache.set(rawId, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
    return streams;
  }

  clearStreamCache(): void { this.streamCache.clear(); }
}
