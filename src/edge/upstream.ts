import {
  decodeCncPayloadData, decodeCncRawId, MAX_CNC_RAW_ID_LENGTH,
  validateUpstreamMetasWithAudit, validateUpstreamStreams,
} from "../domain/cnc";
import { API_VERSION, SERVICE_NAME, type UpstreamStream } from "../types";
import type { RequestBudget } from "./budget";
import type { EdgeCache } from "./cache";

export {
  decodeCncPayloadData, decodeCncRawId, MAX_CNC_RAW_ID_LENGTH,
  validateUpstreamMetasWithAudit, validateUpstreamStreams,
};

export const DEFAULT_UPSTREAM_HOSTS = ["https://cncverse.dpdns.org"] as const;
export const CNC_ENABLED_EXTENSIONS = ["CricifyLiveEvents"] as const;
export const CNC_DISABLED_EXTENSIONS = "VegaMovies,Rogmovies,CastleTVUseVLC,Netflix,PrimeVideo,Hotstar,Disney,Marvel,StarWars,Pixar,MovieBoxIN,SportzXHighlights,JIOTVPlusIND3,JioHotstar2,LivXowHighlights,SKTechProvider_SUNNXT,PlayFyHighlights,JIOTVIND,HDHub4U,4KHDHUB,Movies4u,Kisskh,AniPM,ReANIME,GoTaku,Toonix,CastleTV,EasyPlayLiveTV,JioTvPlus,ClownIPTV".split(",");

const STREAM_CACHE_TTL_MS = 25_000, STREAM_CACHE_MAX_ENTRIES = 250;
const CB_FAILURE_THRESHOLD = 3, CB_COOLDOWN_MS = 30_000;
const FETCH_TIMEOUT_MS = 6_500, STREAM_FETCH_TIMEOUT_MS = 10_000, SPECULATIVE_HEDGE_DELAY_MS = 650;
const DEFAULT_PROFILE_TTL_SEC = 21_600, PROFILE_MIN_TTL_SEC = 300, PROFILE_MAX_TTL_SEC = 86_400;
const PROFILE_SETUP_TIMEOUT_MS = 4_000, PROFILE_ROTATE_COOLDOWN_MS = 60_000, PROFILE_FAIL_BACKOFF_MS = 60_000;
const L2_PROFILE_KEY = "cnc:profile:v1", PROFILE_ID_RE = /^p_[a-z0-9]{6,32}$/i, BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export interface HostBreakerState {
  host: string; state: "closed" | "open" | "half-open"; failures: number; openedAt: number; probeInFlight: boolean;
}
export interface ProfileConfig { profilesRaw?: string; ttlSecRaw?: string; waitUntil?: (p: Promise<unknown>) => void; }
export interface ProfileStatus { mode: "pool" | "auto" | "fallback"; active: boolean; rotations: number; expiresAt: string | null; }
interface StreamCacheEntry { streams: UpstreamStream[]; expiresAt: number; }
interface ActiveProfile { pid: string; expiresAt: number; }

function clampProfileTtlSec(raw?: string): number {
  const n = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(n) ? Math.max(PROFILE_MIN_TTL_SEC, Math.min(PROFILE_MAX_TTL_SEC, n)) : DEFAULT_PROFILE_TTL_SEC;
}

function generateProfileId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let id = "p_";
  for (const b of buf) id += BASE36[b % 36] ?? "0";
  return id;
}

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
  private readonly cache?: EdgeCache;
  private readonly breakers = new Map<string, HostBreakerState>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly streamCache = new Map<string, StreamCacheEntry>();
  private activeProfile: ActiveProfile | null = null;
  private profilePromise: Promise<string> | null = null;
  private profileFailUntil = 0;
  private forceRotate = false;
  private lastRotateAt = 0;
  private profileRotations = 0;
  private poolIdx = 0;
  private poolRotateAt = 0;
  private profileMode: "pool" | "auto" | "fallback" = "auto";

  constructor(hosts: ReadonlyArray<string> = DEFAULT_UPSTREAM_HOSTS, cache?: EdgeCache) {
    this.hosts = hosts.length ? hosts : DEFAULT_UPSTREAM_HOSTS;
    this.cache = cache;
    for (const host of this.hosts) this.breakers.set(host, { host, state: "closed", failures: 0, openedAt: 0, probeInFlight: false });
  }

  getHostHealth(): Array<{ host: string; state: "closed" | "open" | "half-open"; failures: number }> {
    const now = Date.now();
    return this.hosts.map((host) => {
      const b = this.breakers.get(host);
      return !b ? { host, state: "closed", failures: 0 } : { host, state: b.state === "open" && now - b.openedAt >= CB_COOLDOWN_MS ? "half-open" : b.state, failures: b.failures };
    });
  }

  getProfileStatus(): ProfileStatus {
    const now = Date.now();
    if (this.profileMode === "pool") return { mode: "pool", active: true, rotations: this.profileRotations, expiresAt: this.poolRotateAt > now ? new Date(this.poolRotateAt).toISOString() : null };
    const active = Boolean(this.activeProfile && this.activeProfile.expiresAt > now);
    return { mode: active ? "auto" : this.profileMode, active, rotations: this.profileRotations, expiresAt: active && this.activeProfile ? new Date(this.activeProfile.expiresAt).toISOString() : null };
  }

  resetProfileState(): void {
    this.activeProfile = null; this.profilePromise = null; this.profileFailUntil = 0;
    this.forceRotate = false; this.lastRotateAt = 0; this.profileRotations = 0; this.poolIdx = 0; this.poolRotateAt = 0; this.profileMode = "auto";
  }

  private notifyProfileRejected(): void {
    const now = Date.now();
    if (now - this.lastRotateAt < PROFILE_ROTATE_COOLDOWN_MS) return;
    this.lastRotateAt = now;
    if (this.profileMode === "pool") { this.poolIdx++; this.poolRotateAt = 0; this.profileRotations++; return; }
    this.activeProfile = null;
    this.forceRotate = true;
  }

  async resolveProfilePrefix(cfg?: ProfileConfig, budget?: RequestBudget): Promise<string> {
    const now = Date.now(), ttlSec = clampProfileTtlSec(cfg?.ttlSecRaw);
    const pool = cfg?.profilesRaw ? cfg.profilesRaw.split(",").map((s) => s.trim()).filter((s) => PROFILE_ID_RE.test(s)) : [];
    if (pool.length) {
      this.profileMode = "pool";
      if (this.poolRotateAt && now >= this.poolRotateAt) { this.poolIdx = (this.poolIdx + 1) % pool.length; this.profileRotations++; this.poolRotateAt = now + ttlSec * 1000; }
      else if (!this.poolRotateAt) this.poolRotateAt = now + ttlSec * 1000;
      return `/u/${pool[this.poolIdx % pool.length]}`;
    }

    if (this.activeProfile && this.activeProfile.expiresAt > now) { this.profileMode = "auto"; return `/u/${this.activeProfile.pid}`; }
    if (now < this.profileFailUntil) { this.profileMode = "fallback"; return ""; }
    if (this.profilePromise) return this.profilePromise;

    const job = (async (): Promise<string> => {
      if (!this.forceRotate && this.cache) {
        const raw = await this.cache.getSnapshotText(L2_PROFILE_KEY);
        if (raw) {
          try {
            const p = JSON.parse(raw) as Partial<ActiveProfile>;
            if (typeof p.pid === "string" && PROFILE_ID_RE.test(p.pid) && typeof p.expiresAt === "number" && p.expiresAt > Date.now() + 30_000) {
              this.activeProfile = { pid: p.pid, expiresAt: p.expiresAt };
              this.profileMode = "auto";
              return `/u/${p.pid}`;
            }
          } catch { /* ignore malformed L2 entry */ }
        }
      }

      const host = [...this.hosts].sort((a, b) => (this.isOpen(a) ? 1 : 0) - (this.isOpen(b) ? 1 : 0))[0];
      if (!host || !/^https?:\/\/[^/]*cncverse/i.test(host) || (budget && !budget.tryAcquire("critical"))) { this.profileMode = "fallback"; return ""; }
      const pid = generateProfileId(), tc = new AbortController(), timer = setTimeout(() => tc.abort(), PROFILE_SETUP_TIMEOUT_MS);
      try {
        const res = await fetch(`${host}/api/profile/${pid}/set`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": `${SERVICE_NAME}/${API_VERSION}` },
          body: JSON.stringify({ enabledExtensions: CNC_ENABLED_EXTENSIONS, disabledExtensions: CNC_DISABLED_EXTENSIONS, disabledCatalogs: [] }),
          signal: tc.signal,
        });
        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`Profile HTTP ${res.status}`); }
        if (!ct.includes("json")) throw new Error(`Profile non-JSON (${ct})`);
        await res.text();
        const hadPrev = this.activeProfile !== null || this.forceRotate;
        this.forceRotate = false;
        this.activeProfile = { pid, expiresAt: Date.now() + ttlSec * 1000 };
        this.profileMode = "auto";
        if (hadPrev) this.profileRotations++;
        this.cache?.putSnapshotText(L2_PROFILE_KEY, JSON.stringify(this.activeProfile), ttlSec, cfg?.waitUntil);
        return `/u/${pid}`;
      } catch {
        this.profileFailUntil = Date.now() + PROFILE_FAIL_BACKOFF_MS;
        this.profileMode = "fallback";
        return "";
      } finally { clearTimeout(timer); }
    })().finally(() => { this.profilePromise = null; });

    this.profilePromise = job;
    return job;
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
      if (!res.ok) {
        if ((res.status === 403 || res.status === 429) && path.startsWith("/u/")) this.notifyProfileRejected();
        await res.body?.cancel().catch(() => {});
        throw new Error(`Upstream HTTP ${res.status}`);
      }
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

  private async fetchWithProfileRetry(suffix: string, budget?: RequestBudget, profileCfg?: ProfileConfig, timeoutMs = FETCH_TIMEOUT_MS, tripOnTimeout = true): Promise<unknown> {
    const prefix = await this.resolveProfilePrefix(profileCfg, budget);
    try {
      return await this.fetchJson(`${prefix}${suffix}`, budget, timeoutMs, tripOnTimeout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (prefix && (msg === "Upstream HTTP 403" || msg === "Upstream HTTP 429")) {
        const nextPrefix = await this.resolveProfilePrefix(profileCfg, budget);
        if (nextPrefix && nextPrefix !== prefix) return this.fetchJson(`${nextPrefix}${suffix}`, budget, timeoutMs, tripOnTimeout);
      }
      throw err;
    }
  }

  async fetchCatalog(providerKey: string, catalogId: string, budget?: RequestBudget, profileCfg?: ProfileConfig) {
    return validateUpstreamMetasWithAudit(providerKey, await this.fetchWithProfileRetry(`/catalog/tv/${encodeURIComponent(catalogId)}.json`, budget, profileCfg));
  }

  async fetchStreams(rawId: string, budget?: RequestBudget, profileCfg?: ProfileConfig): Promise<UpstreamStream[]> {
    const cached = this.streamCache.get(rawId);
    if (cached && cached.expiresAt > Date.now()) { this.streamCache.delete(rawId); this.streamCache.set(rawId, cached); return cached.streams; }
    const streams = validateUpstreamStreams(await this.fetchWithProfileRetry(`/stream/tv/${encodeURIComponent(rawId)}.json`, budget, profileCfg, STREAM_FETCH_TIMEOUT_MS, false));
    if (this.streamCache.size >= STREAM_CACHE_MAX_ENTRIES) { const oldest = this.streamCache.keys().next().value; if (oldest !== undefined) this.streamCache.delete(oldest); }
    this.streamCache.set(rawId, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
    return streams;
  }

  clearStreamCache(): void { this.streamCache.clear(); }
}
