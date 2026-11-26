import { API_VERSION, type ProblemDetails } from "../types";

const TEXT_ENCODER = new TextEncoder();

export const EXPOSE_HEADERS =
  "ETag, X-Cache, X-PlayOn-Version, X-Request-Id, Server-Timing, Content-Length, Content-Range, Accept-Ranges, Content-Type";

export const BASE_EDGE_HEADERS: Readonly<Record<string, string>> = {
  "X-PlayOn-Version": API_VERSION,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": EXPOSE_HEADERS,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  Vary: "Accept-Encoding",
};

const BASE_JSON_TUPLES: ReadonlyArray<[string, string]> = [
  ...Object.entries(BASE_EDGE_HEADERS),
  ["Content-Type", "application/json; charset=utf-8"],
];

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  413: "Payload Too Large", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
};

export interface CorsPolicy { allowOrigin: string | null; vary: string; }

export function resolveCorsPolicy(request: Request, allowedOriginsRaw?: string): CorsPolicy {
  if (!allowedOriginsRaw?.trim()) return { allowOrigin: "*", vary: "Accept-Encoding" };
  const list = allowedOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes("*")) return { allowOrigin: "*", vary: "Accept-Encoding" };
  const reqOrigin = request.headers.get("Origin")?.trim();
  return { allowOrigin: reqOrigin && list.includes(reqOrigin) ? reqOrigin : null, vary: "Origin, Accept-Encoding" };
}

export function buildEdgeHeaders(cors: CorsPolicy, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...BASE_EDGE_HEADERS, Vary: cors.vary };
  if (cors.allowOrigin) out["Access-Control-Allow-Origin"] = cors.allowOrigin;
  else delete out["Access-Control-Allow-Origin"];
  if (extra) for (const k in extra) { const v = extra[k]; if (v !== undefined) out[k] = v; }
  return out;
}

export function applyCorsToHeaders(headers: Headers, cors: CorsPolicy): void {
  if (cors.allowOrigin) headers.set("Access-Control-Allow-Origin", cors.allowOrigin);
  else headers.delete("Access-Control-Allow-Origin");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  headers.set("Vary", cors.vary);
}

export function problemResponse(
  status: number, code: string, detail: string, instance: string, cors: CorsPolicy, extra?: Record<string, string>
): Response {
  const body: ProblemDetails = {
    type: `https://playon.dev/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: STATUS_TITLES[status] ?? "Error", status, code, detail, instance,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: buildEdgeHeaders(cors, { "Content-Type": "application/problem+json; charset=utf-8", "Cache-Control": "no-store", ...extra }),
  });
}

export interface CacheStats {
  l1Hits: number; l2Hits: number; misses: number; evictions: number;
  entries: number; bytes: number; maxBytes: number;
}

interface L1Entry {
  body: string; byteLength: number; etag: string; cacheControl: string; status: number; expiresAt: number; hdrTuples?: ReadonlyArray<[string, string]>;
}

export function computeWeakEtag(input: Uint8Array | string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9, i = 0;
  const len = typeof input === "string" ? input.length : input.byteLength;
  if (typeof input === "string") {
    for (; i + 3 < len; i += 4) {
      h1 = Math.imul(h1 ^ (input.charCodeAt(i) | (input.charCodeAt(i + 1) << 16)), 0x01000193);
      h2 = Math.imul(h2 ^ (input.charCodeAt(i + 2) | (input.charCodeAt(i + 3) << 16)), 0x85ebca6b);
    }
    for (; i < len; i++) { const c = input.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b); }
  } else {
    for (; i < len; i++) { const b = input[i] ?? 0; h1 = Math.imul(h1 ^ b, 0x01000193); h2 = Math.imul(h2 ^ (b + i), 0x85ebca6b); }
  }
  return `W/"${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${len.toString(16)}"`;
}

export function matchesIfNoneMatch(ifNoneMatch: string | null, currentEtag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const strip = (tag: string): string => { const t = tag.trim(); return t.startsWith("W/") || t.startsWith("w/") ? t.slice(2).trim() : t; };
  const target = strip(currentEtag);
  if (!trimmed.includes(",")) return strip(trimmed) === target;
  for (const part of trimmed.split(",")) if (strip(part) === target) return true;
  return false;
}

const isWildcardCors = (cors?: CorsPolicy): boolean => !cors || (cors.allowOrigin === "*" && cors.vary === "Accept-Encoding");

function buildJsonHeaders(
  cors: CorsPolicy | undefined, cacheControl: string, xCache: string, etag: string,
  requestId?: string, serverTiming?: string, cachedTuples?: ReadonlyArray<[string, string]>
): [string, string][] {
  const hdrs: [string, string][] = isWildcardCors(cors)
    ? (cachedTuples ? [...cachedTuples] : [...BASE_JSON_TUPLES, ["Cache-Control", cacheControl], ["X-Cache", xCache], ["ETag", etag]])
    : Object.entries(buildEdgeHeaders(cors as CorsPolicy, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl, "X-Cache": xCache, ETag: etag }));
  if (requestId) hdrs.push(["X-Request-Id", requestId]);
  if (serverTiming) hdrs.push(["Server-Timing", serverTiming]);
  return hdrs;
}

export class EdgeCache {
  private readonly l1 = new Map<string, L1Entry>();
  private totalBytes = 0;
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxEntries = 200, private readonly maxBytes = 16 * 1024 * 1024, private readonly maxEntryBytes = 4 * 1024 * 1024) {}

  static buildKey(ns: string, parts: Record<string, string | number | boolean | undefined>): string {
    let key = `api:${ns.length}:${ns}`;
    for (const k of Object.keys(parts).sort()) { const v = parts[k]; if (v !== undefined && v !== "") { const s = String(v); key += `|${k.length}:${k}=${s.length}:${s}`; } }
    return key;
  }

  private getL2(): Cache | null { return typeof caches === "undefined" ? null : (caches as { default?: Cache }).default ?? null; }
  private toL2Req(key: string): Request { return new Request(`https://cache.playon.internal/${encodeURIComponent(key)}`, { method: "GET" }); }

  private putL2(key: string, text: string, headers: Record<string, string>, waitUntil?: (p: Promise<unknown>) => void): void {
    const l2 = this.getL2();
    if (!l2) return;
    const bytes = TEXT_ENCODER.encode(text);
    if (bytes.byteLength > this.maxEntryBytes) return;
    const put = l2.put(this.toL2Req(key), new Response(bytes, { status: 200, headers })).catch(() => {});
    if (waitUntil) waitUntil(put);
  }

  async getSnapshotText(key: string): Promise<string | null> {
    const l2 = this.getL2();
    if (!l2) return null;
    try { const c = await l2.match(this.toL2Req(key)); if (!c) return null; this.l2Hits++; return await c.text(); } catch { return null; }
  }

  putSnapshotText(key: string, text: string, ttl: number, waitUntil?: (p: Promise<unknown>) => void): void {
    if (ttl > 0) this.putL2(key, text, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}` }, waitUntil);
  }

  getL1Sync(key: string, req: Request, reqId?: string, timing?: string, cors?: CorsPolicy): Response | null {
    const e = this.l1.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { this.deleteL1(key, e); return null; }
    this.l1.delete(key); this.l1.set(key, e); this.l1Hits++;
    const base = isWildcardCors(cors) ? (e.hdrTuples ??= [...BASE_JSON_TUPLES, ["Cache-Control", e.cacheControl], ["ETag", e.etag], ["X-Cache", "HIT-L1"]]) : undefined;
    const hdrs = buildJsonHeaders(cors, e.cacheControl, "HIT-L1", e.etag, reqId, timing, base);
    const is304 = matchesIfNoneMatch(req.headers.get("If-None-Match"), e.etag);
    return new Response(is304 || req.method === "HEAD" ? null : e.body, { status: is304 ? 304 : e.status, headers: hdrs });
  }

  hasL2(): boolean { return this.getL2() !== null; }
  recordMiss(): void { this.misses++; }

  async get(key: string, req: Request, extra?: Record<string, string>, cors?: CorsPolicy): Promise<{ response: Response; tier: "L1" | "L2" } | null> {
    const l1 = this.getL1Sync(key, req, extra?.["X-Request-Id"], extra?.["Server-Timing"], cors);
    if (l1) return { response: l1, tier: "L1" };
    const l2 = this.getL2();
    if (l2) {
      try {
        const c = await l2.match(this.toL2Req(key));
        if (c) {
          this.l2Hits++;
          const etag = c.headers.get("ETag"), h = new Headers(c.headers);
          for (const k in BASE_EDGE_HEADERS) { const v = BASE_EDGE_HEADERS[k]; if (v !== undefined) h.set(k, v); }
          if (cors) applyCorsToHeaders(h, cors);
          h.set("X-Cache", "HIT-L2");
          if (extra) for (const k in extra) { const v = extra[k]; if (v !== undefined) h.set(k, v); }
          const is304 = Boolean(etag && matchesIfNoneMatch(req.headers.get("If-None-Match"), etag));
          if (is304 || req.method === "HEAD") { await c.body?.cancel().catch(() => {}); return { response: new Response(null, { status: is304 ? 304 : c.status, headers: h }), tier: "L2" }; }
          return { response: new Response(c.body, { status: c.status, headers: h }), tier: "L2" };
        }
      } catch { /* ignore outside Workers */ }
    }
    this.misses++;
    return null;
  }

  putRawJson(key: string, req: Request, text: string, ttl: number, swr: number, waitUntil?: (p: Promise<unknown>) => void, reqId?: string, timing?: string, preEtag?: string, cors?: CorsPolicy): Response {
    const etag = preEtag ?? computeWeakEtag(text), cc = ttl > 0 ? `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${swr}` : "no-store", bytes = text.length * 2;
    if (ttl > 0 && bytes <= this.maxEntryBytes) {
      this.storeL1(key, { body: text, byteLength: bytes, etag, cacheControl: cc, status: 200, expiresAt: Date.now() + ttl * 1000 });
      if (this.getL2()) this.putL2(key, text, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cc, ETag: etag, Vary: "Accept-Encoding" }, waitUntil);
    }
    const is304 = ttl > 0 && matchesIfNoneMatch(req.headers.get("If-None-Match"), etag);
    return new Response(is304 || req.method === "HEAD" ? null : text, { status: is304 ? 304 : 200, headers: buildJsonHeaders(cors, cc, ttl > 0 ? "MISS" : "BYPASS", etag, reqId, timing) });
  }

  putJson(key: string, req: Request, payload: unknown, ttl: number, swr: number, waitUntil?: (p: Promise<unknown>) => void, extra?: Record<string, string>, cors?: CorsPolicy): Response {
    return this.putRawJson(key, req, JSON.stringify(payload), ttl, swr, waitUntil, extra?.["X-Request-Id"], extra?.["Server-Timing"], undefined, cors);
  }

  private storeL1(key: string, e: L1Entry): void {
    const ex = this.l1.get(key);
    if (ex) this.deleteL1(key, ex);
    while ((this.l1.size >= this.maxEntries || this.totalBytes + e.byteLength > this.maxBytes) && this.l1.size > 0) {
      const ok = this.l1.keys().next().value, old = ok !== undefined ? this.l1.get(ok) : undefined;
      if (!ok || !old) break;
      this.deleteL1(ok, old); this.evictions++;
    }
    this.l1.set(key, e); this.totalBytes += e.byteLength;
  }

  private deleteL1(k: string, e: L1Entry): void { this.l1.delete(k); this.totalBytes = Math.max(0, this.totalBytes - e.byteLength); }
  clear(): void { this.l1.clear(); this.totalBytes = 0; }
  getStats(): CacheStats { return { l1Hits: this.l1Hits, l2Hits: this.l2Hits, misses: this.misses, evictions: this.evictions, entries: this.l1.size, bytes: this.totalBytes, maxBytes: this.maxBytes }; }
}
