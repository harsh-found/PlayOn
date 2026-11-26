import { PROVIDERS, PROVIDER_NAME_BY_KEY } from "../data/taxonomy";
import { cmp, slugify } from "../domain/normalizer";
import {
  buildCatalogSnapshot, extractCandidate, hydrateSnapshot,
  queryEventsSerializedFromSnapshot, queryFacetsFromSnapshot, serializeSnapshot,
  type CatalogSnapshot, type IndexedEventRecord, type ProviderCatalogResult,
} from "../domain/reconciliation";
import { computeMinTokenExpiryMs, extractForwardHeaders, StreamEngine, type RawProviderStreamInput } from "../domain/streams";
import type {
  EventDetailPayload, EventsQuery, FacetsPayload, PlayableStream, ProxyEnv,
  StreamProtocol, StreamProviderBreakdown, StreamQuery, StreamsPayload,
} from "../types";
import type { RequestBudget } from "./budget";
import type { EdgeCache } from "./cache";
import { DeadStreamTracker } from "./dead-streams";
import { HlsInspector } from "./hls";
import { buildSignedProxyUrl, resolveProxySigTtlSec } from "./signing";
import { mapWithConcurrency, UpstreamClient } from "./upstream";

export { buildCatalogSnapshot, extractCandidate, hydrateSnapshot, serializeSnapshot, type CatalogSnapshot, type IndexedEventRecord, type ProviderCatalogResult };

const SNAPSHOT_SOFT_TTL_MS = 45_000, SNAPSHOT_HARD_TTL_MS = 300_000, L2_SNAPSHOT_KEY = "snapshot:api:v3";
const FANOUT_CONC = 4, HLS_PROBE_MAX = 3, HLS_PROBE_BUDGET_MS = 1_200, DEFAULT_QUORUM_MS = 1_800, DEFAULT_MIN_QUORUM = 3;

export interface AggregatorOptions { cache?: EdgeCache; deadStreams?: DeadStreamTracker; softQuorumMs?: number; minQuorumProviders?: number; }
export interface StreamFetchContext { proxyOrigin?: string; env?: ProxyEnv; budget?: RequestBudget; }
export interface StreamFetchResult { payload: StreamsPayload; allStreams: PlayableStream[]; minTokenExpiryMs: number | null; signExpMs: number | null; }

export class Aggregator {
  private snapshot: CatalogSnapshot | null = null;
  private refreshPromise: Promise<CatalogSnapshot> | null = null;
  private readonly cache?: EdgeCache;
  public readonly deadStreams: DeadStreamTracker;
  private readonly softQuorumMs: number;
  private readonly minQuorumProviders: number;

  constructor(public readonly upstream = new UpstreamClient(), public readonly hlsInspector = new HlsInspector(), opts: AggregatorOptions = {}) {
    this.cache = opts.cache; this.deadStreams = opts.deadStreams ?? new DeadStreamTracker();
    this.softQuorumMs = opts.softQuorumMs ?? DEFAULT_QUORUM_MS; this.minQuorumProviders = opts.minQuorumProviders ?? DEFAULT_MIN_QUORUM;
  }

  clearSnapshot(): void { this.snapshot = null; this.refreshPromise = null; }

  getWarmSnapshotSync(waitUntil?: (p: Promise<unknown>) => void): CatalogSnapshot | null {
    if (!this.snapshot) return null;
    const age = Date.now() - this.snapshot.fetchedAtMs;
    if (age < SNAPSHOT_SOFT_TTL_MS) return this.snapshot;
    if (age < SNAPSHOT_HARD_TTL_MS) { const bg = this.refreshSnapshot(waitUntil).catch(() => this.snapshot); if (waitUntil) waitUntil(bg); return this.snapshot; }
    return null;
  }

  async getSnapshot(waitUntil?: (p: Promise<unknown>) => void, force = false, budget?: RequestBudget): Promise<CatalogSnapshot> {
    if (!force) { const w = this.getWarmSnapshotSync(waitUntil); if (w) return w; }
    const now = Date.now();
    if (!force && !this.snapshot && this.cache) {
      const raw = await this.cache.getSnapshotText(L2_SNAPSHOT_KEY), hyd = raw ? hydrateSnapshot(raw) : null;
      if (hyd && now - hyd.fetchedAtMs < SNAPSHOT_HARD_TTL_MS) {
        this.snapshot = hyd;
        if (now - hyd.fetchedAtMs >= SNAPSHOT_SOFT_TTL_MS) { const bg = this.refreshSnapshot(waitUntil).catch(() => this.snapshot); if (waitUntil) waitUntil(bg); }
        return hyd;
      }
    }
    try { return await this.refreshSnapshot(waitUntil, budget); }
    catch (err) { if (this.snapshot) return { ...this.snapshot, stale: true, degraded: true }; throw err; }
  }

  private refreshSnapshot(waitUntil?: (p: Promise<unknown>) => void, budget?: RequestBudget): Promise<CatalogSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    const done: Array<ProviderCatalogResult | null> = new Array(PROVIDERS.length).fill(null);
    const fail = (p: (typeof PROVIDERS)[number]): ProviderCatalogResult => ({ provider: p.key, name: p.name, items: [], rawCount: 0, exclusions: [], healthy: false });
    let healthy = 0;

    const full = mapWithConcurrency(PROVIDERS, FANOUT_CONC, async (p, idx) => {
      try { const r = await this.upstream.fetchCatalog(p.key, p.id, budget); healthy++; return (done[idx] = { provider: p.key, name: p.name, items: r.items, rawCount: r.rawCount, exclusions: r.exclusions, healthy: true }); }
      catch { return (done[idx] = fail(p)); }
    }).then((res) => {
      if (!res.some((r) => r.healthy)) throw new Error("All upstream catalog providers are unreachable");
      const now = Date.now(), snap = buildCatalogSnapshot(res, now), prev = this.snapshot;
      if (prev && now - prev.fetchedAtMs < SNAPSHOT_HARD_TTL_MS && snap.healthyProviders < this.minQuorumProviders && prev.healthyProviders > snap.healthyProviders) {
        return { ...prev, stale: true, degraded: true };
      }
      this.snapshot = snap;
      if (this.cache && !snap.degraded && snap.events.length) this.cache.putSnapshotText(L2_SNAPSHOT_KEY, serializeSnapshot(snap), Math.floor(SNAPSHOT_HARD_TTL_MS / 1000), waitUntil);
      return snap;
    }).finally(() => { this.refreshPromise = null; });

    return (this.refreshPromise = new Promise<CatalogSnapshot>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled || healthy < this.minQuorumProviders) return;
        settled = true;
        const q = buildCatalogSnapshot(PROVIDERS.map((p, i) => done[i] ?? fail(p)), Date.now());
        q.degraded = true;
        if (waitUntil) waitUntil(full.catch(() => {}));
        resolve(q);
      }, this.softQuorumMs);
      full.then((s) => { clearTimeout(timer); if (!settled) { settled = true; resolve(s); } }, (e) => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    }));
  }

  queryFacets(s: CatalogSnapshot, opts?: { sport?: string; status?: string; q?: string }): FacetsPayload { return queryFacetsFromSnapshot(s, opts); }
  queryEventsSerialized(s: CatalogSnapshot, q: EventsQuery, nowMs = Date.now()): { body: string; etag?: string } { return queryEventsSerializedFromSnapshot(s, q, nowMs); }

  async resolveEventStreams(snap: CatalogSnapshot, eventId: string, q: StreamQuery, ctx: StreamFetchContext = {}): Promise<StreamFetchResult | null> {
    const rec = snap.byId.get(eventId);
    if (!rec) return null;
    const proxyOrigin = ctx.proxyOrigin ?? "", allowedHosts = ctx.env?.PROXY_ALLOWED_HOSTS, secret = ctx.env?.PROXY_SIGNING_SECRET?.trim() || "", budget = ctx.budget;
    const tasks: Array<{ provider: string; rawId: string }> = [], bd = new Map<string, StreamProviderBreakdown>();
    for (const [provider, rawIds] of Object.entries(rec.debug.providerRawIds).sort((a, b) => cmp(a[0], b[0]))) {
      bd.set(provider, { provider, name: PROVIDER_NAME_BY_KEY[provider] ?? provider, rawIdsQueried: rawIds.length, rawStreamsReturned: 0, status: "empty", latencyMs: 0 });
      for (const rawId of rawIds) tasks.push({ provider, rawId });
    }
    const rawInputs: RawProviderStreamInput[] = [];
    await mapWithConcurrency(tasks, FANOUT_CONC, async ({ provider, rawId }) => {
      const t0 = performance.now(), b = bd.get(provider);
      try {
        const list = await this.upstream.fetchStreams(rawId, budget);
        if (b) { b.latencyMs = Math.max(b.latencyMs, Math.round((performance.now() - t0) * 100) / 100); b.rawStreamsReturned += list.length; if (list.length) b.status = "ok"; }
        for (const stream of list) rawInputs.push({ provider, stream });
      } catch { if (b && b.status !== "ok") b.status = "failed"; }
    });

    const isDem = (u: string) => this.deadStreams.isDemoted(u);
    const { streams: deduped, audit } = StreamEngine.deduplicateAndRank(rawInputs, proxyOrigin, isDem);

    if (q.inspect !== false && deduped.length) {
      const cands = deduped.filter((s) => s.protocol === "hls" && !isDem(s.url)).slice(0, HLS_PROBE_MAX);
      if (cands.length) {
        let expired = false, pt: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(cands.map(async (s) => { const r = await this.hlsInspector.inspect(s.url, s.headers, 1_000, allowedHosts, budget, this.deadStreams); if (!expired) StreamEngine.applyHlsProbe(s, r, isDem(s.url)); })),
            new Promise<void>((r) => { pt = setTimeout(() => { expired = true; r(); }, HLS_PROBE_BUDGET_MS); }),
          ]);
        } finally { if (pt !== undefined) clearTimeout(pt); }
        StreamEngine.rankStreamsInPlace(deduped);
      }
    }

    let signExpMs: number | null = null;
    if (secret && deduped.length) {
      const expSec = Math.floor(Date.now() / 1000) + resolveProxySigTtlSec(ctx.env?.PROXY_SIG_TTL_SEC);
      signExpMs = expSec * 1000;
      await Promise.all(deduped.map(async (s) => { s.proxyUrl = await buildSignedProxyUrl(proxyOrigin, { url: s.url, ...extractForwardHeaders(s.headers), rewrite: true }, secret, expSec); }));
    }

    const langs: string[] = [], quals: string[] = [], protos: StreamProtocol[] = [], bcs: string[] = [], out: PlayableStream[] = [];
    const qL = q.language?.trim().toLowerCase(), qQ = q.quality?.trim().toLowerCase(), qP = q.provider?.trim().toLowerCase(), qB = q.broadcaster ? slugify(q.broadcaster) : null;
    for (const s of deduped) {
      if (!langs.includes(s.language)) langs.push(s.language);
      if (!quals.includes(s.quality)) quals.push(s.quality);
      if (!protos.includes(s.protocol)) protos.push(s.protocol);
      if (!bcs.includes(s.broadcaster)) bcs.push(s.broadcaster);
      if ((!qL || s.language.toLowerCase() === qL) && (!qQ || s.quality.toLowerCase() === qQ) && (!q.protocol || s.protocol === q.protocol) && (!qP || s.providers.includes(qP)) && (!qB || slugify(s.broadcaster) === qB || slugify(s.broadcasterGroup) === qB) && (!q.drmFree || s.drm === null) && (!q.webPlayable || s.webPlayable)) out.push(s);
    }
    langs.sort(cmp); protos.sort(cmp); bcs.sort(cmp);
    return {
      payload: { eventId, total: out.length, recommendedId: out[0]?.id ?? null, filters: { languages: langs, qualities: quals, protocols: protos, broadcasters: bcs }, streams: out, ...(q.includeDebug ? { debug: { providers: [...bd.values()], audit } } : {}) },
      allStreams: deduped, minTokenExpiryMs: computeMinTokenExpiryMs(out.length ? out : deduped), signExpMs,
    };
  }

  async resolveEventDetail(snap: CatalogSnapshot, eventId: string, incStreams: boolean, sq: StreamQuery, ctx: StreamFetchContext = {}): Promise<{ payload: EventDetailPayload; minTokenExpiryMs: number | null; signExpMs: number | null } | null> {
    const rec = snap.byId.get(eventId);
    if (!rec) return null;
    const base: EventDetailPayload = sq.includeDebug ? { ...rec.event, debug: rec.debug } : { ...rec.event };
    if (!incStreams) return { payload: base, minTokenExpiryMs: null, signExpMs: null };
    const r = await this.resolveEventStreams(snap, eventId, sq, ctx);
    if (!r) return { payload: base, minTokenExpiryMs: null, signExpMs: null };
    const { payload: sp, allStreams } = r;
    base.streams = sp.streams; base.streamCount = allStreams.length;
    if (sp.filters.languages.length) base.languages = sp.filters.languages;
    if (sp.filters.broadcasters.length) base.broadcasters = sp.filters.broadcasters;
    base.hasDrmFree = allStreams.some((s) => s.drm === null); base.hasWebPlayable = allStreams.some((s) => s.webPlayable);
    let topQ: string | null = null, topH = 0;
    for (const s of allStreams) if (s.height !== null && s.height > topH && s.quality !== "Auto") { topH = s.height; topQ = s.quality; }
    if (topQ) base.maxQuality = topQ;
    base.streamMeta = { total: sp.total, recommendedId: sp.recommendedId, languages: sp.filters.languages, qualities: sp.filters.qualities, ...(sp.debug ? { debug: sp.debug } : {}) };
    return { payload: base, minTokenExpiryMs: r.minTokenExpiryMs, signExpMs: r.signExpMs };
  }
}
