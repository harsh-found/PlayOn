import type { StreamRendition } from "../types";

export const MAX_HEADER_VALUE_BYTES = 512;

const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const M3U8_URI_ATTR_RE = /(#EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT):[^\r\n]*?URI=")([^"]+)(")/gi;
const BLOCKED_HOSTS = new Set("localhost,localhost.localdomain,ip6-localhost,ip6-loopback,metadata.google.internal,metadata,instance-data".split(","));
const BLOCKED_SUFFIXES = ".localhost,.local,.internal,.home.arpa,.localdomain".split(",");
const STREAM_INF_RE = /#EXT-X-STREAM-INF:([^\r\n]+)/i, BANDWIDTH_RE = /BANDWIDTH=(\d+)/i, RESOLUTION_RE = /RESOLUTION=(\d+)x(\d+)/i, FPS_RE = /FRAME-RATE=([\d.]+)/i, CODECS_RE = /CODECS="([^"]+)"/i;

export interface HlsProbeResult { verified: boolean; isLive: boolean; maxHeight: number | null; maxBitrateBps: number | null; renditions: StreamRendition[]; }
export interface ForwardedProxyHeaders { referer?: string | null; origin?: string | null; ua?: string | null; }

function parseIpv4Uint32(host: string): number | null {
  if (!host || !/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts = host.split(".");
  if (!parts.length || parts.length > 4) return null;
  const nums = parts.map((p) => (/^0[xX][0-9a-fA-F]+$/.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : /^\d+$/.test(p) ? parseInt(p, 10) : -1));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [a = -1, b = -1, c = -1, d = -1] = nums, len = nums.length;
  return len === 1 ? (a <= 0xffffffff ? a >>> 0 : null)
    : len === 2 ? (a <= 255 && b <= 0xffffff ? ((a << 24) | b) >>> 0 : null)
    : len === 3 ? (a <= 255 && b <= 255 && c <= 0xffff ? ((a << 24) | (b << 16) | c) >>> 0 : null)
    : a <= 255 && b <= 255 && c <= 255 && d <= 255 ? ((a << 24) | (b << 16) | (c << 8) | d) >>> 0 : null;
}

function isBlockedIpv4(ip: number): boolean {
  const b0 = (ip >>> 24) & 255, b1 = (ip >>> 16) & 255, b2 = (ip >>> 8) & 255;
  return !b0 || b0 === 10 || b0 === 127 || b0 >= 224 || (b0 === 100 && b1 >= 64 && b1 <= 127) || (b0 === 169 && b1 === 254) || (b0 === 172 && b1 >= 16 && b1 <= 31) ||
    (b0 === 192 && (b1 === 168 || (!b1 && (!b2 || b2 === 2)) || (b1 === 88 && b2 === 99))) ||
    (b0 === 198 && (b1 === 18 || b1 === 19 || (b1 === 51 && b2 === 100))) || (b0 === 203 && !b1 && b2 === 113);
}

function parseIpv6Groups(raw: string): number[] | null {
  let host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (!host.includes(":") || host.includes("%")) return null;
  const lc = host.lastIndexOf(":"), tail = host.slice(lc + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Uint32(tail);
    if (v4 === null) return null;
    host = `${host.slice(0, lc + 1)}${((v4 >>> 16) & 65535).toString(16)}:${(v4 & 65535).toString(16)}`;
  }
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (!s ? [] : s.split(":").every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? s.split(":").map((g) => parseInt(g, 16)) : null);
  const left = parse(halves[0] ?? ""), right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  return halves.length === 1 ? (missing === 0 ? left : null) : missing >= 1 ? [...left, ...new Array<number>(missing).fill(0), ...right] : null;
}

function isBlockedIpv6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  return (!g0 && !g1 && !g2 && !g3 && ((!g4 && !g5) || (!g4 && g5 === 0xffff) || (g4 === 0xffff && !g5))) ||
    (g0 === 0x0064 && g1 === 0xff9b) || (g0 === 0x0100 && !g1 && !g2 && !g3) ||
    (g0 === 0x2001 && (!g1 || g1 === 0x0db8 || (g1 === 0x0002 && !g2))) ||
    g0 === 0x2002 || (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

const isM3uExt = (ref: string, end: number): boolean => {
  const s = end >= 5 && ref.charCodeAt(end - 1) === 56 ? end - 1 : end;
  return s >= 4 && ref.charCodeAt(s - 4) === 46 && (ref.charCodeAt(s - 3) | 32) === 109 && ref.charCodeAt(s - 2) === 51 && (ref.charCodeAt(s - 1) | 32) === 117;
};

export const isValidHeaderName = (name: string): boolean => name.length > 0 && name.length <= 64 && HEADER_NAME_RE.test(name);
export function sanitizeHeaderValue(value: string | null | undefined): string | null {
  if (!value || /[\r\n\0]/.test(value)) return null;
  const t = value.trim();
  return t && t.length <= MAX_HEADER_VALUE_BYTES ? t : null;
}

export function isSafeTargetUrl(rawUrl: string, allowedHosts?: string): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return false;
  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost || rawHost.includes("%")) return false;
  const host = rawHost.replace(/\.+$/, "");
  if (!host || BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (host.startsWith("[") || host.includes(":")) { const g = parseIpv6Groups(host); if (!g || isBlockedIpv6(g)) return false; }
  else { const v4 = parseIpv4Uint32(host); if (v4 !== null && isBlockedIpv4(v4)) return false; }
  if (!allowedHosts?.trim()) return true;
  const pats = allowedHosts.split(",").map((p) => p.trim().toLowerCase().replace(/\.+$/, "")).filter(Boolean);
  return !pats.length || pats.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

export const heightToLabel = (h: number): string =>
  h >= 2160 ? "4K" : h >= 1440 ? "1440p" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : h >= 576 ? "576p" : h >= 540 ? "540p" : h >= 480 ? "480p" : h >= 396 ? "396p" : h >= 360 ? "360p" : `${h}p`;

export function parseHlsMasterPlaylist(text: string, baseUrl: string): HlsProbeResult | null {
  if (!text.trimStart().startsWith("#EXTM3U")) return null;
  const isLive = !/#EXT-X-ENDLIST\b/i.test(text), lines = text.split(/\r?\n/), renditions: StreamRendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const inf = STREAM_INF_RE.exec((lines[i] ?? "").trim());
    if (!inf?.[1]) continue;
    let nextUri = "";
    for (let j = i + 1; j < lines.length; j++) { const c = (lines[j] ?? "").trim(); if (c && !c.startsWith("#")) { nextUri = c; i = j; break; } }
    if (!nextUri) continue;
    let url = nextUri;
    try { url = new URL(nextUri, baseUrl).href; } catch { /* keep raw */ }
    const a = inf[1], bw = BANDWIDTH_RE.exec(a), res = RESOLUTION_RE.exec(a), fps = FPS_RE.exec(a), cod = CODECS_RE.exec(a);
    const width = res?.[1] ? +res[1] : 0, height = res?.[2] ? +res[2] : 0, bitrateBps = bw?.[1] ? +bw[1] : 0;
    renditions.push({ quality: height > 0 ? heightToLabel(height) : bitrateBps > 3_500_000 ? "1080p" : "720p", width, height, bitrateBps, fps: fps?.[1] ? Math.round(parseFloat(fps[1])) : 0, codecs: cod?.[1] ?? null, url });
  }
  renditions.sort((a, b) => b.height - a.height || b.bitrateBps - a.bitrateBps);
  const top = renditions[0];
  return { verified: true, isLive, maxHeight: top?.height ? top.height : null, maxBitrateBps: top?.bitrateBps ? top.bitrateBps : null, renditions };
}

export function rewriteM3u8Playlist(
  playlistText: string, playlistUrl: string, proxyOrigin: string, fwd: ForwardedProxyHeaders,
  allowedHosts?: string, formatCustomUrl?: (resolvedTargetUrl: string, isPlaylist: boolean) => string
): string {
  const baseUrl = new URL(playlistUrl), baseSafe = isSafeTargetUrl(baseUrl.href, allowedHosts);
  const lastSlash = baseUrl.pathname.lastIndexOf("/");
  const baseDirUrl = `${baseUrl.origin}${lastSlash >= 0 ? baseUrl.pathname.slice(0, lastSlash + 1) : "/"}`;
  const proxyPrefix = `${proxyOrigin}/api/proxy?url=`, prefixDir = proxyPrefix + encodeURIComponent(baseDirUrl), prefixOrg = proxyPrefix + encodeURIComponent(baseUrl.origin);
  const plSuf = `${fwd.referer ? `&referer=${encodeURIComponent(fwd.referer)}` : ""}${fwd.origin ? `&origin=${encodeURIComponent(fwd.origin)}` : ""}${fwd.ua ? `&ua=${encodeURIComponent(fwd.ua)}` : ""}`;
  const binSuf = `${plSuf}&rewrite=false`, safeOrg = new Map<string, boolean>([[baseUrl.origin, baseSafe]]);

  const wrapUri = (rawRef: string, forceRewrite = false): string => {
    const n = rawRef.length;
    if (!n) return rawRef;
    const c0 = rawRef.charCodeAt(0), isSlash = c0 === 47, isProtoRel = isSlash && rawRef.charCodeAt(1) === 47;
    if (!formatCustomUrl && baseSafe && !isProtoRel && c0 !== 46 && c0 !== 63 && c0 !== 35) {
      let out = "", segStart = 0, pathEnd = n, hasDotDot = false, hasColon = false, fastOk = true, prevDot = false;
      for (let i = 0; i < n; i++) {
        const c = rawRef.charCodeAt(i);
        if (c === 46) { if (prevDot) { hasDotDot = true; fastOk = false; } prevDot = true; continue; }
        prevDot = false;
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 45 || c === 95 || c === 126) continue;
        if (c === 47) { if (fastOk) { out += rawRef.slice(segStart, i) + "%2F"; segStart = i + 1; } continue; }
        if (c === 58) hasColon = true;
        if ((c === 63 || c === 35) && pathEnd === n) pathEnd = i;
        fastOk = false;
      }
      if (!hasDotDot && !hasColon) return (isSlash ? prefixOrg : prefixDir) + (fastOk ? (segStart ? out + rawRef.slice(segStart) : rawRef) : encodeURIComponent(rawRef)) + (forceRewrite || isM3uExt(rawRef, pathEnd) ? plSuf : binSuf);
    }
    try {
      const qIdx = rawRef.indexOf("?"), hIdx = rawRef.indexOf("#");
      const pathEnd = qIdx !== -1 && (hIdx === -1 || qIdx < hIdx) ? qIdx : hIdx !== -1 ? hIdx : n;
      const resolved = new URL(isProtoRel ? `${baseUrl.protocol}${rawRef}` : rawRef, baseUrl);
      let ok = safeOrg.get(resolved.origin);
      if (ok === undefined) safeOrg.set(resolved.origin, (ok = isSafeTargetUrl(resolved.href, allowedHosts)));
      if (!ok) return rawRef;
      const isPlaylist = forceRewrite || isM3uExt(rawRef, pathEnd);
      return formatCustomUrl ? formatCustomUrl(resolved.href, isPlaylist) : proxyPrefix + encodeURIComponent(resolved.href) + (isPlaylist ? plSuf : binSuf);
    } catch { return rawRef; }
  };

  let result = "", lastCopy = 0;
  for (let pos = 0, len = playlistText.length; pos < len;) {
    const nl = playlistText.indexOf("\n", pos), endNl = nl === -1 ? len : nl;
    const lineEnd = endNl > pos && playlistText.charCodeAt(endNl - 1) === 13 ? endNl - 1 : endNl;
    if (lineEnd > pos) {
      let s = pos, e = lineEnd;
      while (s < e && playlistText.charCodeAt(s) <= 32) s++;
      while (e > s && playlistText.charCodeAt(e - 1) <= 32) e--;
      if (s < e) {
        let rep: string | null = null;
        if (playlistText.charCodeAt(s) === 35) {
          if (e - s > 14 && (playlistText.charCodeAt(s + 5) | 32) === 120) {
            const line = playlistText.slice(pos, lineEnd);
            if (line.includes('URI="')) {
              const up = line.slice(s - pos, s - pos + 26).toUpperCase(), isPl = up.startsWith("#EXT-X-MEDIA:") || up.startsWith("#EXT-X-I-FRAME-STREAM-INF:");
              M3U8_URI_ATTR_RE.lastIndex = 0;
              rep = line.replace(M3U8_URI_ATTR_RE, (_m, pre: string, uri: string, post: string) => `${pre}${wrapUri(uri, isPl)}${post}`);
            }
          }
        } else rep = wrapUri(playlistText.slice(s, e));
        if (rep !== null) { result += playlistText.slice(lastCopy, pos) + rep; lastCopy = lineEnd; }
      }
    }
    pos = endNl + 1;
  }
  return lastCopy ? result + playlistText.slice(lastCopy) : playlistText;
}
