import { isSafeTargetUrl, MAX_HEADER_VALUE_BYTES, rewriteM3u8Playlist, sanitizeHeaderValue } from "../domain/m3u8";
import { API_VERSION, SERVICE_NAME, type ProxyEnv } from "../types";
import type { RequestBudget } from "./budget";
import { applyCorsToHeaders, buildEdgeHeaders, problemResponse, resolveCorsPolicy } from "./cache";
import type { DeadStreamTracker } from "./dead-streams";
import { buildSignedProxyUrl, resolveProxySigTtlSec, verifySignedProxyParams } from "./signing";

export const MAX_PROXY_REDIRECTS = 5;
export const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
export { MAX_HEADER_VALUE_BYTES };

const M3U8_CT_RE = /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i;
const BLOCKED_RESP_HDRS = new Set("connection,keep-alive,proxy-authenticate,proxy-authorization,te,trailers,transfer-encoding,upgrade,set-cookie,set-cookie2,content-security-policy,content-security-policy-report-only,x-frame-options,x-content-type-options".split(","));

export interface ProxyContext { budget?: RequestBudget; deadStreams?: DeadStreamTracker; }

export class StreamProxy {
  static sanitizeHeaderValue = sanitizeHeaderValue;
  static isSafeTargetUrl = isSafeTargetUrl;
  static rewriteM3u8Playlist = rewriteM3u8Playlist;

  static async readBoundedText(res: Response, maxBytes = MAX_PLAYLIST_BYTES): Promise<{ ok: true; text: string; bytes: number } | { ok: false; bytes: number }> {
    const cl = parseInt(res.headers.get("content-length") ?? "", 10);
    if (cl > maxBytes) { await res.body?.cancel().catch(() => {}); return { ok: false, bytes: cl }; }
    if (!res.body) return { ok: true, text: "", bytes: 0 };
    const reader = res.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); return { ok: false, bytes: total }; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
    return { ok: true, text: new TextDecoder().decode(merged), bytes: total };
  }

  static async fetchSafeRedirects(
    initialUrl: string, method: "GET" | "HEAD", headers: Headers, maxHops: number,
    allowedHosts?: string, signal?: AbortSignal, budget?: RequestBudget
  ): Promise<{ ok: true; response: Response; finalUrl: string } | { ok: false; status: number; code: string; detail: string }> {
    const fail = (status: number, code: string, detail: string) => ({ ok: false as const, status, code, detail });
    let url = initialUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
      if (budget && !budget.tryAcquire("critical")) return fail(503, "SUBREQUEST_BUDGET_EXCEEDED", "Request subrequest budget exceeded.");
      let res: Response;
      try { res = await fetch(url, { method, headers, redirect: "manual", signal }); }
      catch { return fail(502, "UPSTREAM_FETCH_FAILED", "Upstream unreachable."); }
      if (res.status >= 301 && res.status <= 308 && res.status !== 304 && res.status !== 305 && res.status !== 306) {
        const loc = res.headers.get("Location");
        await res.body?.cancel().catch(() => {});
        if (!loc || hop === maxHops) return fail(502, "REDIRECT_LIMIT_EXCEEDED", "Redirect limit exceeded.");
        let next: string;
        try { next = new URL(loc, url).href; } catch { return fail(502, "INVALID_REDIRECT", "Malformed redirect."); }
        if (!isSafeTargetUrl(next, allowedHosts)) return fail(403, "REDIRECT_TARGET_BLOCKED", "Redirect blocked by egress policy.");
        url = next; continue;
      }
      return { ok: true, response: res, finalUrl: url };
    }
    return fail(502, "UPSTREAM_FETCH_FAILED", "No upstream response.");
  }

  static async handleProxyRequest(request: Request, env?: ProxyEnv, ctx?: ProxyContext): Promise<Response> {
    const reqUrl = new URL(request.url), sp = reqUrl.searchParams, allowedHosts = env?.PROXY_ALLOWED_HOSTS;
    const signingSecret = env?.PROXY_SIGNING_SECRET?.trim() || "", cors = resolveCorsPolicy(request, env?.ALLOWED_ORIGINS);
    const err = (s: number, c: string, d: string) => problemResponse(s, c, d, reqUrl.pathname, cors);

    const targetUrl = sp.get("url")?.trim();
    if (!targetUrl) return err(400, "MISSING_TARGET_URL", "Missing 'url' parameter.");
    if (!isSafeTargetUrl(targetUrl, allowedHosts)) return err(403, "PROXY_TARGET_BLOCKED", "Target blocked by egress policy.");

    const rawRef = sp.get("referer"), rawOrg = sp.get("origin"), rawUa = sp.get("ua");
    const referer = rawRef ? sanitizeHeaderValue(rawRef) : null, origin = rawOrg ? sanitizeHeaderValue(rawOrg) : null, ua = rawUa ? sanitizeHeaderValue(rawUa) : null;
    if ((rawRef && !referer) || (rawOrg && !origin) || (rawUa && !ua)) return err(400, "INVALID_PROXY_HEADER", "Invalid header override.");

    const rewriteEnabled = sp.get("rewrite") !== "false";
    let signedExpSec = 0;
    if (signingSecret) {
      const check = await verifySignedProxyParams({ url: targetUrl, referer, origin, ua, rewrite: rewriteEnabled }, sp.get("exp"), sp.get("sig"), signingSecret);
      if (!check.ok) return err(403, check.code, check.detail);
      signedExpSec = Math.min(Number.parseInt((sp.get("exp") ?? "").trim(), 10), Math.floor(Date.now() / 1000) + resolveProxySigTtlSec(env?.PROXY_SIG_TTL_SEC));
    }

    const upHdrs = new Headers({ "User-Agent": ua ?? `${SERVICE_NAME}/${API_VERSION}` });
    if (referer) upHdrs.set("Referer", referer);
    if (origin) upHdrs.set("Origin", origin);
    const range = request.headers.get("Range");
    if (range && /^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/i.test(range.trim())) upHdrs.set("Range", range.trim());

    const method = request.method === "HEAD" ? "HEAD" : "GET";
    const fetched = await this.fetchSafeRedirects(targetUrl, method, upHdrs, MAX_PROXY_REDIRECTS, allowedHosts, undefined, ctx?.budget);
    if (!fetched.ok) { if (fetched.status >= 500) ctx?.deadStreams?.recordFailure(targetUrl); return err(fetched.status, fetched.code, fetched.detail); }
    const { response: upRes, finalUrl: curUrl } = fetched;
    if (upRes.status === 403 || upRes.status === 404 || upRes.status === 410 || upRes.status >= 500) ctx?.deadStreams?.recordFailure(targetUrl);
    else if (upRes.status === 200 || upRes.status === 206) ctx?.deadStreams?.recordSuccess(targetUrl);

    const outHdrs = new Headers();
    upRes.headers.forEach((v, k) => { const low = k.toLowerCase(); if (!low.startsWith("access-control-") && !BLOCKED_RESP_HDRS.has(low)) outHdrs.set(k, v); });
    const baseEdge = buildEdgeHeaders(cors, { "Access-Control-Allow-Headers": "Range, Origin, Content-Type, Accept" });
    for (const k in baseEdge) { const v = baseEdge[k]; if (v !== undefined) outHdrs.set(k, v); }
    applyCorsToHeaders(outHdrs, cors);

    if (method === "GET" && rewriteEnabled && upRes.ok && (M3U8_CT_RE.test(upRes.headers.get("content-type") ?? "") || /\.m3u8?(?:\?|$)/i.test(curUrl))) {
      const read = await this.readBoundedText(upRes, MAX_PLAYLIST_BYTES);
      if (!read.ok) return err(413, "PLAYLIST_TOO_LARGE", `Playlist exceeds ${MAX_PLAYLIST_BYTES} bytes.`);
      outHdrs.delete("content-length"); outHdrs.delete("content-encoding");
      if (read.text.trimStart().startsWith("#EXTM3U")) {
        outHdrs.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        outHdrs.set("Cache-Control", "no-store");
        if (!signingSecret) return new Response(rewriteM3u8Playlist(read.text, curUrl, reqUrl.origin, { referer, origin, ua }, allowedHosts), { status: upRes.status, headers: outHdrs });
        const pending: Array<{ target: string; isPlaylist: boolean }> = [], indexByKey = new Map<string, number>();
        const tokenized = rewriteM3u8Playlist(read.text, curUrl, reqUrl.origin, { referer, origin, ua }, allowedHosts, (resolvedHref, isPlaylist) => {
          const mk = `${isPlaylist ? "1" : "0"}|${resolvedHref}`;
          let idx = indexByKey.get(mk);
          if (idx === undefined) { idx = pending.length; indexByKey.set(mk, idx); pending.push({ target: resolvedHref, isPlaylist }); }
          return `\u0000MM${idx}\u0000`;
        });
        const signedUrls = await Promise.all(pending.map((it) => buildSignedProxyUrl(reqUrl.origin, { url: it.target, referer, origin, ua, rewrite: it.isPlaylist }, signingSecret, signedExpSec)));
        return new Response(tokenized.replace(/\u0000MM(\d+)\u0000/g, (_m, n: string) => signedUrls[Number(n)] ?? ""), { status: upRes.status, headers: outHdrs });
      }
      return new Response(read.text, { status: upRes.status, headers: outHdrs });
    }

    if (method === "HEAD") { await upRes.body?.cancel().catch(() => {}); return new Response(null, { status: upRes.status, headers: outHdrs }); }
    return new Response(upRes.body, { status: upRes.status, headers: outHdrs });
  }
}
