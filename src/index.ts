import { PROVIDERS } from "./data/taxonomy";
import { createOpenApiResponse } from "./docs/openapi";
import { decodeQueryVal, scanQueryParams } from "./domain/normalizer";
import type { CatalogSnapshot } from "./domain/reconciliation";
import { Aggregator } from "./edge/aggregator";
import { RequestBudget } from "./edge/budget";
import { applyCorsToHeaders, buildEdgeHeaders, EdgeCache, problemResponse, resolveCorsPolicy, type CorsPolicy } from "./edge/cache";
import { StreamProxy } from "./edge/proxy";
import { EdgeTelemetry, emitRequestLog, resolveLogLevel } from "./edge/telemetry";
import { UpstreamClient } from "./edge/upstream";
import { API_VERSION, SERVICE_NAME, type EventsQuery, type StreamProtocol, type StreamQuery, type WorkerEnv } from "./types";

export type { WorkerEnv };
export interface AppDependencies { aggregator?: Aggregator; cache?: EdgeCache; telemetry?: EdgeTelemetry; }

const MAX_Q = 120, TOKEN_TTL_SAFETY_SEC = 10;
const PROTOS = new Set("hls,dash,direct".split(","));
const ENUM_OPTS: Record<string, Set<string>> = {
  status: new Set("live,upcoming,ended,active,all".split(",")), kind: new Set("match,session,channel,show".split(",")),
  window: new Set("live,2h,today,tomorrow,24h,7d".split(",")), sort: new Set("smart,time_asc,time_desc,popularity,title".split(",")), protocol: PROTOS,
};
const INT_BOUNDS: Record<string, readonly [number, number]> = { limit: [1, 100], offset: [0, 10_000], page: [1, 1_000], minProviders: [1, PROVIDERS.length] };
const STR_EVENT_KEYS = new Set("sport,competition,team,broadcaster,language,provider,from,to".split(","));
const STR_STREAM_KEYS = new Set("language,quality,provider,broadcaster".split(","));
const EVENT_CACHE_KEYS = "status,sport,competition,team,broadcaster,language,kind,provider,minProviders,hot,date,from,to,window,q,sort,limit,offset,page,includeDebug".split(",");
let reqSeq = 0;

function parseUrlParts(rawUrl: string): { origin: string; pathname: string; queryStr: string } {
  const s = rawUrl.indexOf("://"), p = s === -1 ? 0 : rawUrl.indexOf("/", s + 3);
  if (p === -1) return { origin: rawUrl, pathname: "/", queryStr: "" };
  const origin = s === -1 ? "" : rawUrl.slice(0, p), q = rawUrl.indexOf("?", p);
  return q === -1 ? { origin, pathname: rawUrl.slice(p), queryStr: "" } : { origin, pathname: rawUrl.slice(p, q), queryStr: rawUrl.slice(q + 1) };
}

function scanQueryDecoded(qs: string, onPair: (k: string, v: string) => void): void {
  const dec = qs.includes("%") || qs.includes("+");
  scanQueryParams(qs, (k, v) => onPair(dec ? decodeQueryVal(k) : k, dec && v ? decodeQueryVal(v) : v));
}

const parseBoolOpt = (raw: string): boolean | undefined => {
  const v = raw.toLowerCase();
  return v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined;
};

function parseStreamQuery(qs: string): { query: StreamQuery; includeStreams?: boolean } | { error: string } {
  const q: Record<string, unknown> = {};
  let includeStreams: boolean | undefined, error: string | null = null;
  scanQueryDecoded(qs, (k, rawV) => {
    const v = error ? "" : rawV.trim();
    if (!v) return;
    if (STR_STREAM_KEYS.has(k)) q[k] = v;
    else if (k === "protocol") { const l = v.toLowerCase(); if (!PROTOS.has(l)) error = "Invalid 'protocol'. Expected hls | dash | direct."; else q.protocol = l as StreamProtocol; }
    else if (k === "drmFree" || k === "webPlayable" || k === "inspect" || k === "dashToHls") q[k] = parseBoolOpt(v);
    else if (k === "streams") includeStreams = parseBoolOpt(v);
    else if (k === "include" && v.toLowerCase().split(",").includes("debug")) q.includeDebug = true;
  });
  return error ? { error } : { query: q as StreamQuery, includeStreams };
}

function parseEventsQuery(qs: string): { query: EventsQuery; cacheKey: string } | { error: string } {
  if (!qs) return { query: {}, cacheKey: "e" };
  const q: Record<string, unknown> = {};
  let error: string | null = null;
  scanQueryDecoded(qs, (k, rawV) => {
    const v = error ? "" : rawV.trim();
    if (!v) return;
    const en = ENUM_OPTS[k], bd = INT_BOUNDS[k];
    if (en) { const l = v.toLowerCase(); if (!en.has(l)) error = `Invalid '${k}'.`; else q[k] = l; }
    else if (bd) { const n = /^\d+$/.test(v) ? parseInt(v, 10) : -1; if (n < bd[0] || n > bd[1]) error = `Invalid '${k}'. Expected ${bd[0]}..${bd[1]}.`; else q[k] = n; }
    else if (STR_EVENT_KEYS.has(k)) q[k] = v;
    else if (k === "q") { if (v.length > MAX_Q) error = `Search query 'q' exceeds ${MAX_Q} characters.`; else q.q = v; }
    else if (k === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) error = "Invalid 'date'. Expected YYYY-MM-DD."; else q.date = v; }
    else if (k === "hot") q.hot = parseBoolOpt(v);
    else if (k === "include" && v.toLowerCase().split(",").includes("debug")) q.includeDebug = true;
  });
  if (error) return { error };
  let cacheKey = "e";
  for (const ck of EVENT_CACHE_KEYS) cacheKey += q[ck] === undefined ? "|" : `|${q[ck]}`;
  return { query: q as EventsQuery, cacheKey };
}

function computeStreamTtl(defaultTtl: number, blocked: boolean, minExpMs: number | null, signExpMs: number | null): number {
  if (blocked) return 0;
  const nowMs = Date.now();
  let ttl = defaultTtl;
  for (const exp of [minExpMs, signExpMs]) {
    if (exp === null) continue;
    const rem = Math.floor((exp - nowMs) / 1000) - TOKEN_TTL_SAFETY_SEC;
    if (rem <= 0) return 0;
    if (rem < ttl) ttl = rem;
  }
  return Math.max(0, ttl);
}

function finalizeResponse(res: Response, method: string, requestId: string, durMs: number, cors: CorsPolicy): Response {
  const apply = (h: Headers) => {
    const base = buildEdgeHeaders(cors, { "X-Request-Id": requestId, "Server-Timing": `total;dur=${durMs}` });
    for (const k in base) { const v = base[k]; if (v !== undefined) h.set(k, v); }
    applyCorsToHeaders(h, cors);
  };
  try {
    apply(res.headers);
    return method === "HEAD" && res.body !== null ? new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
  } catch {
    const h = new Headers(res.headers);
    apply(h);
    return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

export function createApp(deps: AppDependencies = {}) {
  const cache = deps.cache ?? new EdgeCache(), aggregator = deps.aggregator ?? new Aggregator(new UpstreamClient(undefined, cache), undefined, { cache }), telemetry = deps.telemetry ?? new EdgeTelemetry();
  const UPSTREAM_ERR = "All upstream catalog providers are unreachable.";

  const app = {
    fetch(request: Request, env?: WorkerEnv, ctx?: ExecutionContext): Response | Promise<Response> {
      const start = performance.now(), cfRay = request.headers.get("cf-ray"), reqId = cfRay ?? `po-${(++reqSeq).toString(36)}`;
      const method = request.method, cors = resolveCorsPolicy(request, env?.ALLOWED_ORIGINS), logLevel = resolveLogLevel(env?.LOG_LEVEL);
      const budget = new RequestBudget(), cf = (request as Request & { cf?: { colo?: string; country?: string; city?: string } }).cf, colo = cf?.colo ?? "LOCAL";

      if (method === "OPTIONS") return new Response(null, { status: 204, headers: buildEdgeHeaders(cors, { "Access-Control-Allow-Headers": "Content-Type, Range, Origin, Accept, If-None-Match", "Access-Control-Max-Age": "86400", "X-Request-Id": reqId }) });

      const { origin, pathname, queryStr } = parseUrlParts(request.url), waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
      const dur = (): number => Math.round((performance.now() - start) * 100) / 100;
      const prob = (s: number, c: string, d: string, extra?: Record<string, string>) => problemResponse(s, c, d, pathname, cors, { "X-Request-Id": reqId, "Server-Timing": `total;dur=${dur()}`, ...extra });
      const finish = (res: Response, d = dur(), degraded = false): Response => {
        telemetry.record(pathname, res.status, d);
        if (logLevel !== "silent") emitRequestLog(logLevel, { requestId: reqId, cfRay, colo, method, route: EdgeTelemetry.normalizePath(pathname, res.status), status: res.status, durMs: d, cache: res.headers.get("X-Cache") ?? "NONE", subrequests: budget.used, degraded });
        return res;
      };

      if (method !== "GET" && method !== "HEAD") return finish(prob(405, "METHOD_NOT_ALLOWED", `Method '${method}' is not allowed. Supported methods: GET, HEAD, OPTIONS.`, { Allow: "GET, HEAD, OPTIONS" }));

      const checkL2 = async (key: string, d0: number): Promise<Response | null> => {
        if (!cache.hasL2()) { cache.recordMiss(); return null; }
        const hit = await cache.get(key, request, { "X-Request-Id": reqId, "Server-Timing": `total;dur=${d0}` }, cors);
        return hit ? finish(hit.response, d0) : null;
      };
      const serveCached = (key: string, ttlOf: (s: CatalogSnapshot) => number, render: (s: CatalogSnapshot) => { body: string; etag?: string }): Response | Promise<Response> => {
        const d0 = dur(), l1 = cache.getL1Sync(key, request, reqId, `total;dur=${d0}`, cors);
        if (l1) return finish(l1, d0);
        const putSnap = (snap: CatalogSnapshot) => { const { body, etag } = render(snap), d1 = dur(); return finish(cache.putRawJson(key, request, body, ttlOf(snap), 30, waitUntil, reqId, `total;dur=${d1}`, etag, cors), d1, snap.degraded || snap.stale); };
        if (!cache.hasL2()) { cache.recordMiss(); const warm = aggregator.getWarmSnapshotSync(waitUntil, env); if (warm) return putSnap(warm); }
        return (async () => { try { return (await checkL2(key, d0)) ?? putSnap(await aggregator.getSnapshot(waitUntil, false, budget, env)); } catch { return finish(prob(503, "UPSTREAM_UNAVAILABLE", UPSTREAM_ERR), dur(), true); } })();
      };

      if (pathname === "/api/events") {
        const parsed = parseEventsQuery(queryStr);
        if ("error" in parsed) return finish(prob(400, "INVALID_QUERY", parsed.error));
        return serveCached(parsed.cacheKey, (s) => (s.stale || s.degraded ? 0 : parsed.query.status === "ended" ? 60 : 15), (s) => aggregator.queryEventsSerialized(s, parsed.query));
      }

      if (pathname === "/api/facets") {
        let sport: string | undefined, status: string | undefined, q: string | undefined, badSt = false;
        scanQueryDecoded(queryStr, (k, rawV) => {
          const v = rawV.trim();
          if (!v) return;
          if (k === "sport") sport = v.toLowerCase();
          else if (k === "status") { const low = v.toLowerCase(); if (!ENUM_OPTS.status?.has(low)) badSt = true; else status = low; }
          else if (k === "q") q = v;
        });
        if (badSt) return finish(prob(400, "INVALID_QUERY", "Invalid 'status'. Expected live | upcoming | ended | active | all."));
        if (q && q.length > MAX_Q) return finish(prob(400, "INVALID_QUERY", `Query 'q' exceeds ${MAX_Q} chars.`));
        return serveCached(`f|${sport ?? ""}|${status ?? ""}|${q ?? ""}`, (s) => (s.stale || s.degraded ? 0 : 30), (s) => {
          const body = JSON.stringify({ data: aggregator.queryFacets(s, { sport, status, q }), meta: { stale: s.stale, generatedAt: s.generatedAt } });
          return { body, etag: `W/"f${(s.fetchedAtMs >>> 0).toString(16)}-${body.length.toString(16)}"` };
        });
      }

      return (async () => {
        try {
          const checkCache = async (key: string) => { const d0 = dur(), l1 = cache.getL1Sync(key, request, reqId, `total;dur=${d0}`, cors); return l1 ? finish(l1, d0) : checkL2(key, d0); };
          const isDet = pathname.startsWith("/api/events/"), isStr = !isDet && pathname.startsWith("/api/stream/");
          if (isDet || isStr) {
            const rawId = pathname.slice(12);
            if (rawId && !rawId.includes("/")) {
              let id: string | null = null;
              try { id = decodeURIComponent(rawId); } catch { id = null; }
              if (!id) return finish(prob(400, "INVALID_EVENT_ID", "Malformed percent-encoding in event ID."));
              const pSq = parseStreamQuery(queryStr);
              if ("error" in pSq) return finish(prob(400, "INVALID_QUERY", pSq.error));
              const sq = pSq.query, incS = pSq.includeStreams !== false;
              const key = EdgeCache.buildKey(isStr ? "stream" : "event", { id, origin, signed: env?.PROXY_SIGNING_SECRET?.trim() ? "1" : "0", ...(isStr ? {} : { streams: incS }), language: sq.language, quality: sq.quality, protocol: sq.protocol, provider: sq.provider, broadcaster: sq.broadcaster, drmFree: sq.drmFree, webPlayable: sq.webPlayable, inspect: sq.inspect, dashToHls: sq.dashToHls ? "1" : undefined, debug: sq.includeDebug });
              const cached = await checkCache(key);
              if (cached) return cached;
              try {
                const snap = await aggregator.getSnapshot(waitUntil, false, budget, env), sCtx = { proxyOrigin: origin, env, budget, waitUntil };
                const res = isStr ? await aggregator.resolveEventStreams(snap, id, sq, sCtx) : await aggregator.resolveEventDetail(snap, id, incS, sq, sCtx);
                if (!res) return finish(prob(404, "EVENT_NOT_FOUND", `Event '${id}' was not found.`));
                const ttl = computeStreamTtl(20, snap.stale || snap.degraded, res.minTokenExpiryMs, res.signExpMs), d1 = dur();
                return finish(cache.putRawJson(key, request, JSON.stringify({ data: res.payload, meta: { stale: snap.stale, generatedAt: snap.generatedAt } }), ttl, ttl > 0 ? Math.min(20, ttl) : 0, waitUntil, reqId, `total;dur=${d1}`, undefined, cors), d1, snap.stale || snap.degraded);
              } catch { return finish(prob(503, "UPSTREAM_UNAVAILABLE", UPSTREAM_ERR), dur(), true); }
            }
          }

          if (pathname === "/api/proxy") { const res = await StreamProxy.handleProxyRequest(request, env, { budget, deadStreams: aggregator.deadStreams }), d = dur(); return finish(finalizeResponse(res, method, reqId, d, cors), d); }
          if (pathname === "/api/openapi.json") { const res = createOpenApiResponse(request, cors), d = dur(); return finish(finalizeResponse(res, method, reqId, d, cors), d); }
          if (pathname === "/") {
            const key = `m|${API_VERSION}`, cached = await checkCache(key);
            if (cached) return cached;
            const d1 = dur();
            return finish(cache.putRawJson(key, request, JSON.stringify({
              data: { service: SERVICE_NAME, version: API_VERSION, providers: PROVIDERS.map((p) => ({ key: p.key, name: p.name })), links: { facets: "/api/facets", events: "/api/events", eventDetail: "/api/events/{id}", stream: "/api/stream/{id}", proxy: "/api/proxy?url={url}", health: "/api/health", metrics: "/api/metrics", openapi: "/api/openapi.json" } },
              meta: { stale: false, generatedAt: new Date().toISOString() },
            }), 300, 300, waitUntil, reqId, `total;dur=${d1}`, undefined, cors), d1);
          }

          if (pathname === "/api/health" || pathname === "/api/metrics") {
            let snap: CatalogSnapshot | null = null;
            try { snap = await aggregator.getSnapshot(waitUntil, false, budget, env); } catch { snap = null; }
            const d = dur(), hdrs = buildEdgeHeaders(cors, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-Id": reqId, "Server-Timing": `total;dur=${d}` });
            const isH = pathname === "/api/health", hosts = isH ? aggregator.upstream.getHostHealth() : [], healthy = snap?.healthyProviders ?? 0, ok = !isH || (!hosts.every((h) => h.state === "open") && healthy > 0);
            const recon = !snap ? null : queryStr.includes("detail=full") ? snap.reconciliation : { generatedAt: snap.reconciliation.generatedAt, summary: snap.reconciliation.summary, providerAccounting: snap.reconciliation.providerAccounting };
            const data = isH ? { service: SERVICE_NAME, version: API_VERSION, status: ok ? "ok" : "degraded", catalog: !snap || snap.stale || snap.degraded ? "degraded" : "warm", edge: { colo, country: cf?.country ?? "XX", city: cf?.city ?? "Unknown" }, providers: { total: PROVIDERS.length, healthy }, profile: aggregator.upstream.getProfileStatus(), upstreamHosts: hosts } : { telemetry: telemetry.snapshot(), cache: cache.getStats(), deadStreams: aggregator.deadStreams.size, reconciliation: recon };
            const stale = isH ? !ok : recon === null;
            return finish(new Response(method === "HEAD" ? null : JSON.stringify({ data, meta: { stale, generatedAt: new Date().toISOString() } }), { status: isH && !ok ? 503 : 200, headers: hdrs }), d, stale);
          }

          return finish(prob(404, "ROUTE_NOT_FOUND", `No route matches '${pathname}'.`));
        } catch { return finish(prob(500, "INTERNAL_ERROR", "An unexpected internal error occurred."), dur(), true); }
      })();
    },
  };
  return { app, aggregator, cache, telemetry };
}

let defaultInstance: ReturnType<typeof createApp> | null = null;
const getDefaultInstance = () => defaultInstance ?? (defaultInstance = createApp());

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return getDefaultInstance().app.fetch(request, env, ctx);
  },
};
