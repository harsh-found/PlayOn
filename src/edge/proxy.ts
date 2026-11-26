import { convertDashToHls, isDashManifest } from "../domain/dash";
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
    allowedHosts?: string, signal?: AbortSignal, budget?: RequestBudget, timeoutMs?: number
  ): Promise<{ ok: true; response: Response; finalUrl: string } | { ok: false; status: number; code: string; detail: string }> {
    const fail = (status: number, code: string, detail: string) => ({ ok: false as const, status, code, detail });
    let url = initialUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
      if (budget && !budget.tryAcquire("critical")) return fail(503, "SUBREQUEST_BUDGET_EXCEEDED", "Request subrequest budget exceeded.");
      let res: Response;
      let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
      const tc = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
      const onExtAbort = () => tc?.abort();
      if (tc) {
        if (signal?.aborted) tc.abort();
        else signal?.addEventListener("abort", onExtAbort, { once: true });
        timer = setTimeout(() => { timedOut = true; tc.abort(); }, timeoutMs);
      }
      try { res = await fetch(url, { method, headers, redirect: "manual", signal: tc ? tc.signal : signal }); }
      catch { return timedOut ? fail(504, "UPSTREAM_TIMEOUT", "Upstream timed out.") : fail(502, "UPSTREAM_FETCH_FAILED", "Upstream unreachable."); }
      finally { if (timer !== undefined) clearTimeout(timer); if (tc) signal?.removeEventListener("abort", onExtAbort); }
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
    const hlsRaw = sp.get("hls")?.trim().toLowerCase();
    const hlsMode = hlsRaw === "1" || hlsRaw === "true";
    const repId = hlsMode ? (sp.get("rep")?.trim() || null) : null;

    let signedExpSec = 0;
    if (signingSecret) {
      const check = await verifySignedProxyParams(
        { url: targetUrl, referer, origin, ua, rewrite: rewriteEnabled, ...(hlsMode ? { hls: true, rep: repId } : {}) },
        sp.get("exp"), sp.get("sig"), signingSecret
      );
      if (!check.ok) return err(403, check.code, check.detail);
      signedExpSec = Math.min(Number.parseInt((sp.get("exp") ?? "").trim(), 10), Math.floor(Date.now() / 1000) + resolveProxySigTtlSec(env?.PROXY_SIG_TTL_SEC));
    }

    const upHdrs = new Headers({ "User-Agent": ua ?? `${SERVICE_NAME}/${API_VERSION}` });
    if (referer) upHdrs.set("Referer", referer);
    if (origin) upHdrs.set("Origin", origin);
    const range = request.headers.get("Range");
    if (!hlsMode && range && /^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/i.test(range.trim())) upHdrs.set("Range", range.trim());

    const method = request.method === "HEAD" ? "HEAD" : "GET";
    const upTimeoutMs = hlsMode || method === "HEAD" ? 10_000 : 15_000;
    const fetched = await this.fetchSafeRedirects(targetUrl, method, upHdrs, MAX_PROXY_REDIRECTS, allowedHosts, undefined, ctx?.budget, upTimeoutMs);
    if (!fetched.ok) { if (fetched.status >= 500) ctx?.deadStreams?.recordFailure(targetUrl); return err(fetched.status, fetched.code, fetched.detail); }
    const { response: upRes, finalUrl: curUrl } = fetched;
    if (upRes.status === 403 || upRes.status === 404 || upRes.status === 410 || upRes.status >= 500) ctx?.deadStreams?.recordFailure(targetUrl);
    else if (upRes.status === 200 || upRes.status === 206) ctx?.deadStreams?.recordSuccess(targetUrl);

    const outHdrs = new Headers();
    upRes.headers.forEach((v, k) => { const low = k.toLowerCase(); if (!low.startsWith("access-control-") && !BLOCKED_RESP_HDRS.has(low)) outHdrs.set(k, v); });
    const baseEdge = buildEdgeHeaders(cors, { "Access-Control-Allow-Headers": "Range, Origin, Content-Type, Accept" });
    for (const k in baseEdge) { const v = baseEdge[k]; if (v !== undefined) outHdrs.set(k, v); }
    applyCorsToHeaders(outHdrs, cors);

    if (hlsMode && upRes.ok) {
      outHdrs.delete("content-length"); outHdrs.delete("content-encoding");
      outHdrs.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      if (method === "HEAD") { await upRes.body?.cancel().catch(() => {}); return new Response(null, { status: upRes.status, headers: outHdrs }); }
      const read = await this.readBoundedText(upRes, MAX_PLAYLIST_BYTES);
      if (!read.ok) return err(413, "PLAYLIST_TOO_LARGE", `Manifest exceeds ${MAX_PLAYLIST_BYTES} bytes.`);
      if (!isDashManifest(read.text)) return err(422, "DASH_INVALID_MPD", "Upstream response is not an MPEG-DASH MPD manifest.");
      const hdrQ = `${referer ? `&referer=${encodeURIComponent(referer)}` : ""}${origin ? `&origin=${encodeURIComponent(origin)}` : ""}${ua ? `&ua=${encodeURIComponent(ua)}` : ""}`;
      const pending: Array<{ target: string; hls?: boolean; rep?: string; rewrite: boolean }> = [];
      const idxMap = new Map<string, number>();
      const tok = (item: { target: string; hls?: boolean; rep?: string; rewrite: boolean }): string => {
        const mk = `${item.hls ? "1" : "0"}|${item.rewrite ? "1" : "0"}|${item.rep ?? ""}|${item.target}`;
        let idx = idxMap.get(mk);
        if (idx === undefined) { idx = pending.length; idxMap.set(mk, idx); pending.push(item); }
        return `\u0000PO${idx}\u0000`;
      };
      const conv = convertDashToHls(read.text, curUrl, {
        repId,
        nowMs: Date.now(),
        isAllowedUrl: (href) => isSafeTargetUrl(href, allowedHosts),
        formatPlaylistUrl: (id) => signingSecret
          ? tok({ target: curUrl, hls: true, rep: id, rewrite: rewriteEnabled })
          : `${reqUrl.origin}/api/proxy?url=${encodeURIComponent(curUrl)}${hdrQ}&hls=1&rep=${encodeURIComponent(id)}`,
        formatMediaUrl: (href) => signingSecret
          ? tok({ target: href, rewrite: false })
          : `${reqUrl.origin}/api/proxy?url=${encodeURIComponent(href)}${hdrQ}&rewrite=false`,
      });
      if (!conv.ok) return err(conv.status, conv.code, conv.detail);
      outHdrs.set("Cache-Control", conv.isLive ? "public, max-age=2, s-maxage=2" : "public, max-age=30, s-maxage=30");
      if (!signingSecret) return new Response(conv.m3u8, { status: upRes.status, headers: outHdrs });
      const signed = await Promise.all(pending.map((it) => buildSignedProxyUrl(reqUrl.origin, { url: it.target, referer, origin, ua, rewrite: it.rewrite, ...(it.hls ? { hls: true, rep: it.rep } : {}) }, signingSecret, signedExpSec)));
      return new Response(conv.m3u8.replace(/\u0000PO(\d+)\u0000/g, (_m, n: string) => signed[Number(n)] ?? ""), { status: upRes.status, headers: outHdrs });
    }

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
