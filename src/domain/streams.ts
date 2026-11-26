import type {
  PlayableStream, StreamAuditSummary, StreamDrm, StreamExclusion, StreamMirror, StreamProtocol, UpstreamStream,
} from "../types";
import { ChannelNormalizer } from "./channel";
import { DrmDetector } from "./drm";
import { heightToLabel, isValidHeaderName, sanitizeHeaderValue, type HlsProbeResult } from "./m3u8";
import { cmp, decodeQueryVal, memoSet, scanQueryParams, slugify, stableHash } from "./normalizer";

const SPAM_RE = /\b(?:donate|paypal|patreon|buymeacoffee|join\s+telegram|t\.me\/|whatsapp|subscribe\s+channel|support\s+the\s+project|monthly\s+goal|click\s+to\s+donate)\b/;
const SPAM_URL_RE = /donate|paypal|patreon|buymeacoffee|t\.me\/|whatsapp|telegram/i;
const NON_MEDIA_EXT_RE = /\.(?:html?|php|jpe?g|png|gif|webp|svg|css|js|txt|pdf|zip)$/;
const EXPLICIT_HEIGHT_RE = /\b(2160|1440|1080|720|576|540|480|396|360|240)p\b/;
const QUALITY_LABEL_RE = /\b(4k|uhd|fhd|hd|sd)\b/;
const CAM_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bstump\s*cam\b/, "stump_cam"], [/\bspider\s*cam\b/, "spider_cam"], [/\b(?:hero|player)\s*cam\b/, "hero_cam"],
  [/\b(?:onboard|helmet|cockpit|driver)\s*cam\b/, "onboard_cam"], [/\bmulti[\s-]*cam\b/, "multicam"],
  [/\bpit\s*lane\b/, "pit_lane"], [/\bdugout\b/, "dugout"], [/\b(?:tactical|coach(?:es)?)\s*(?:cam|feed|view)\b/, "tactical_cam"],
];
const DRM_HINT_RE = /key|drm|widevine|kid=/;
const REPUTABLE_CDN_RE = /\.(?:cloudfront\.net|akamaized\.net|fastly\.net|aiv-cdn\.net|slivcdn\.com|llnwi\.net|contentfabric\.io)$/;
const TS_URL_RE = /\.ts(?:\?|$)/;
const NITRO_REGION_RE = /^\/[a-z]{3}-nitro\//i;
const TOKEN_EXP_INNER_RE = /(?:^|[~;:,])exp=(\d{10,13})(?:\b|[~;:,&]|$)/i;

const EPHEMERAL_PARAMS = new Set("token,hdnts,hdnea,exp,expires,expire,sig,signature,hmac,auth,session,sid,ts,t,_,wmsauthsign,hash,md5,acl,nonce".split(","));
const LOAD_BEARING_PARAMS = new Set("id,cid,channel,ch,stream,vid,key,kid,clearkey,drm,lang,language,audio,signal,maxh,maxw,quality,profile,format,variant,feed,bitrate,cam,angle".split(","));
const QUALITY_URL_PARAMS = new Set("maxh,maxw,quality,profile,variant,bitrate".split(","));
const EXPIRY_PARAMS = new Set("exp,expires,expire,e".split(","));
const TOKEN_CONTAINER_PARAMS = new Set("hdnea,hdnts,token,auth".split(","));

const hdrSufMemo = new Map<string, string>();
const labelMetaByName = new Map<string, Map<string, ParsedLabelMeta>>();

export interface RawProviderStreamInput { provider: string; stream: UpstreamStream; }

interface FastParsedUrl {
  href: string; protocol: "http:" | "https:"; hostname: string; port: string; pathname: string; lowPath: string; query: string;
}

interface ParsedStreamCandidate {
  provider: string; url: string; directOriginUrl: string | null; originHost: string; protocol: StreamProtocol;
  broadcaster: string; broadcasterGroup: string; bcKey: string; cameraAngle: string | null;
  language: string; languageName: string; quality: string; height: number | null; bitrateBps: number | null;
  headers: Record<string, string> | null; drm: StreamDrm | null;
  baseKey: string; notWebReady: boolean;
}

interface ParsedLabelMeta {
  isSpam: boolean; cameraAngle: string | null; bitrateBps: number | null; drmHint: boolean;
  labelQuality: string | null; labelHeight: number | null;
  channel: { name: string; group: string }; bcKey: string; lang: { code: string; name: string } | null;
}

interface QueryScanResult {
  maxh: string | null; bridgeTarget: string | null; clearkey: string | null;
  qPart: string; hasMaxh: boolean; hasQualityParam: boolean;
}

function parseFastHttpUrl(raw: string): FastParsedUrl | null {
  const sIdx = raw.indexOf("://");
  if (sIdx !== 4 && sIdx !== 5) return null;
  const p = sIdx === 5 && raw.slice(0, 5).toLowerCase() === "https" ? "https:" : sIdx === 4 && raw.slice(0, 4).toLowerCase() === "http" ? "http:" : null;
  if (!p) return null;
  const rest = sIdx + 3, hIdx = raw.indexOf("#", rest), end = hIdx === -1 ? raw.length : hIdx;
  const qIdx = raw.indexOf("?", rest), pEnd = qIdx !== -1 && qIdx < end ? qIdx : end;
  const slIdx = raw.indexOf("/", rest), hasPath = slIdx !== -1 && slIdx < pEnd;
  const pathname = hasPath ? raw.slice(slIdx, pEnd) : "/", authEnd = hasPath ? slIdx : pEnd;
  if (authEnd <= rest) return null;
  let hostname = "", port = "";
  if (raw.charCodeAt(rest) === 91) {
    const close = raw.indexOf("]", rest + 1);
    if (close === -1 || close >= authEnd) return null;
    hostname = raw.slice(rest, close + 1).toLowerCase();
    if (close + 1 < authEnd) { if (raw.charCodeAt(close + 1) !== 58) return null; port = raw.slice(close + 2, authEnd); }
  } else {
    let hostStart = rest, colonIdx = -1;
    for (let i = rest; i < authEnd; i++) {
      const c = raw.charCodeAt(i);
      if (c <= 32) return null;
      if (c === 64) { hostStart = i + 1; colonIdx = -1; } else if (c === 58) colonIdx = i;
    }
    const hostEnd = colonIdx !== -1 ? colonIdx : authEnd;
    if (hostEnd <= hostStart) return null;
    hostname = raw.slice(hostStart, hostEnd).toLowerCase();
    if (colonIdx !== -1) port = raw.slice(colonIdx + 1, authEnd);
  }
  return port && !/^\d{1,5}$/.test(port) ? null
    : { href: raw, protocol: p, hostname, port, pathname, lowPath: pathname.toLowerCase(), query: qIdx !== -1 && qIdx < end ? raw.slice(qIdx + 1, end) : "" };
}

function parseQuerySinglePass(query: string, bridgeOuter = false): QueryScanResult {
  if (!query) return { maxh: null, bridgeTarget: null, clearkey: null, qPart: "", hasMaxh: false, hasQualityParam: false };
  let maxh: string | null = null, bridgeTarget: string | null = null, clearkey: string | null = null, hasMaxh = false, hasQualityParam = false;
  const kept: string[] = [];
  scanQueryParams(query, (rawK, rawV, hasEq) => {
    let decodedV: string | undefined;
    if (hasEq) {
      if (rawK === "maxh" && !maxh) maxh = decodedV = decodeQueryVal(rawV);
      else if (bridgeOuter && (rawK === "d" || rawK === "url" || rawK === "src") && !bridgeTarget) bridgeTarget = decodedV = decodeQueryVal(rawV);
      else if (rawK === "clearkey" && !clearkey) clearkey = decodedV = decodeQueryVal(rawV);
    }
    if (!bridgeOuter) {
      const lower = rawK.toLowerCase();
      if (!EPHEMERAL_PARAMS.has(lower)) {
        if (lower === "maxh") hasMaxh = true;
        if (QUALITY_URL_PARAMS.has(lower)) hasQualityParam = true;
        if (LOAD_BEARING_PARAMS.has(lower) || (!lower.includes("token") && !lower.includes("hmac") && !lower.includes("exp"))) {
          kept.push(`${lower}=${decodedV ?? (hasEq ? decodeQueryVal(rawV) : "")}`);
        }
      }
    }
  });
  const qPart = !kept.length ? "" : kept.length === 1 ? (kept[0] ?? "") : (kept.sort(cmp), kept.join("&"));
  return { maxh, bridgeTarget, clearkey, qPart, hasMaxh, hasQualityParam };
}

const parseEpochToMs = (raw: string): number | null => {
  if (!/^\d{10,13}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? (raw.length >= 13 ? n : n * 1000) : null;
};

export function extractUrlTokenExpiryMs(rawUrl: string, depth = 0): number | null {
  const qIdx = rawUrl.indexOf("?");
  if (qIdx === -1) return null;
  const hIdx = rawUrl.indexOf("#", qIdx + 1), query = rawUrl.slice(qIdx + 1, hIdx === -1 ? rawUrl.length : hIdx);
  let earliest: number | null = null;
  const note = (ms: number | null) => { if (ms !== null && (earliest === null || ms < earliest)) earliest = ms; };
  scanQueryParams(query, (rawK, rawV, hasEq) => {
    if (!hasEq) return;
    const key = rawK.toLowerCase();
    if (EXPIRY_PARAMS.has(key)) note(parseEpochToMs(decodeQueryVal(rawV).trim()));
    else if (TOKEN_CONTAINER_PARAMS.has(key)) { const m = TOKEN_EXP_INNER_RE.exec(decodeQueryVal(rawV)); if (m?.[1]) note(parseEpochToMs(m[1])); }
    else if (depth === 0 && (key === "d" || key === "url" || key === "src")) {
      const inner = decodeQueryVal(rawV).trim();
      if (inner.startsWith("http://") || inner.startsWith("https://")) note(extractUrlTokenExpiryMs(inner, 1));
    }
  });
  return earliest;
}

export function computeMinTokenExpiryMs(streams: ReadonlyArray<Pick<PlayableStream, "url" | "directOriginUrl">>): number | null {
  let earliest: number | null = null;
  const note = (ms: number | null) => { if (ms !== null && (earliest === null || ms < earliest)) earliest = ms; };
  for (const s of streams) { note(extractUrlTokenExpiryMs(s.url)); if (s.directOriginUrl) note(extractUrlTokenExpiryMs(s.directOriginUrl)); }
  return earliest;
}

function parseQualityFromText(low: string): { quality: string | null; height: number | null } {
  const numM = low.includes("p") ? EXPLICIT_HEIGHT_RE.exec(low) : null;
  if (numM?.[1]) { const h = parseInt(numM[1], 10); return { quality: heightToLabel(h), height: h }; }
  const labM = low.includes("d") || low.includes("k") ? QUALITY_LABEL_RE.exec(low) : null;
  if (labM?.[1]) {
    const l = labM[1];
    return l === "4k" || l === "uhd" ? { quality: "4K", height: 2160 } : l === "fhd" ? { quality: "1080p", height: 1080 } : l === "hd" ? { quality: "720p", height: 720 } : { quality: "480p", height: 480 };
  }
  return { quality: null, height: null };
}

function parseBitrate(low: string): number | null {
  const idx = low.indexOf("bps");
  if (idx < 2) return null;
  const unit = low.charCodeAt(idx - 1);
  if (unit !== 109 && unit !== 107) return null;
  let end = idx - 1;
  while (end > 0 && low.charCodeAt(end - 1) === 32) end--;
  let start = end;
  while (start > 0) { const c = low.charCodeAt(start - 1); if ((c >= 48 && c <= 57) || c === 46) start--; else break; }
  if (start === end) return null;
  const val = parseFloat(low.slice(start, end));
  return val > 0 ? Math.round(val * (unit === 109 ? 1_000_000 : 1_000)) : null;
}

function detectCameraAngle(low: string): string | null {
  if (!low || !/cam|pit|dugout|tactical|coach/.test(low)) return null;
  for (const [re, name] of CAM_RULES) if (re.test(low)) return name;
  return null;
}

function parseStreamLabel(name?: string, title?: string): ParsedLabelMeta {
  const n = name ?? "", t = title ?? "", canMemo = n.length + t.length <= 256;
  let byT = canMemo ? labelMetaByName.get(n) : undefined;
  if (byT) { const hit = byT.get(t); if (hit) return hit; }
  const labelText = n ? (t ? `${n} ${t}` : n) : t, lowLabel = labelText.toLowerCase(), isSpam = SPAM_RE.test(lowLabel);
  const channel = isSpam ? { name: "Standard Feed", group: "General Sports" } : ChannelNormalizer.normalize(name, title);
  const lq = isSpam ? { quality: null, height: null } : parseQualityFromText(lowLabel);
  const langRes = isSpam ? null : ChannelNormalizer.extractLanguage(labelText);
  const meta: ParsedLabelMeta = {
    isSpam, cameraAngle: isSpam ? null : detectCameraAngle(lowLabel), bitrateBps: isSpam ? null : parseBitrate(lowLabel),
    drmHint: !isSpam && DRM_HINT_RE.test(lowLabel), labelQuality: lq.quality, labelHeight: lq.height, channel,
    bcKey: channel.group !== "General Sports" ? slugify(channel.name) : "generic",
    lang: langRes && langRes.code !== "eng" ? langRes : null,
  };
  if (canMemo) {
    if (!byT) { if (labelMetaByName.size >= 1024) labelMetaByName.clear(); labelMetaByName.set(n, (byT = new Map())); }
    else if (byT.size >= 128) byT.clear();
    byT.set(t, meta);
  }
  return meta;
}

function sanitizeHeaders(raw?: Record<string, string>): Record<string, string> | null {
  if (!raw) return null;
  let out: Record<string, string> | null = null;
  const seen = new Set<string>();
  for (const k in raw) {
    const low = k.toLowerCase();
    if (!isValidHeaderName(k) || seen.has(low)) continue;
    const clean = sanitizeHeaderValue(raw[k]);
    if (!clean) continue;
    seen.add(low);
    (out ??= {})[k] = clean;
  }
  return out;
}

export function extractForwardHeaders(headers: Record<string, string> | null): { referer: string | null; origin: string | null; ua: string | null } {
  let referer: string | null = null, origin: string | null = null, ua: string | null = null;
  if (!headers) return { referer, origin, ua };
  for (const k in headers) {
    const low = k.toLowerCase(), val = headers[k] ?? null;
    if (!val) continue;
    if (low === "referer" && !referer) referer = val;
    else if (low === "origin" && !origin) origin = val;
    else if (low === "user-agent" && !ua) ua = val;
  }
  return { referer, origin, ua };
}

function encodeHdrSuf(headers: Record<string, string> | null): string {
  const { referer: r, origin: o, ua: u } = extractForwardHeaders(headers);
  if (!r && !o && !u) return "";
  const k = `${r ?? ""}\0${o ?? ""}\0${u ?? ""}`, hit = hdrSufMemo.get(k);
  return hit !== undefined ? hit : memoSet(hdrSufMemo, k, `${r ? `&referer=${encodeURIComponent(r)}` : ""}${o ? `&origin=${encodeURIComponent(o)}` : ""}${u ? `&ua=${encodeURIComponent(u)}` : ""}`, 512);
}

function buildBaseKey(
  target: FastParsedUrl, language: string, cameraAngle: string | null,
  quality: string, hasExplicitUrlQuality: boolean, drm: StreamDrm | null, extraMaxh: string | null,
  preScannedQ?: { qPart: string; hasMaxh: boolean; hasQualityParam: boolean }
): string {
  const isAiv = target.hostname.endsWith(".aiv-cdn.net");
  const host = isAiv ? "*.aiv-cdn.net" : target.hostname;
  const portPart = target.port && target.port !== (target.protocol === "https:" ? "443" : "80") ? `:${target.port}` : "";
  let path = isAiv ? target.pathname.replace(NITRO_REGION_RE, "/nitro/") : target.pathname;
  while (path.length > 1 && path.charCodeAt(path.length - 1) === 47) path = path.slice(0, -1);
  const pq = preScannedQ ?? (target.query ? parseQuerySinglePass(target.query) : { qPart: "", hasMaxh: false, hasQualityParam: false });
  let qPart = pq.qPart, hasQParam = pq.hasQualityParam;
  if (extraMaxh) {
    hasQParam = true;
    if (!pq.hasMaxh) qPart = qPart ? (preScannedQ ? `${qPart}&maxh=${extraMaxh}` : [...qPart.split("&"), `maxh=${extraMaxh}`].sort(cmp).join("&")) : `maxh=${extraMaxh}`;
  }
  let drmKey = "none";
  if (drm) {
    const ks = drm.keys;
    drmKey = !ks?.length ? `${drm.scheme}:anon` : ks.length === 1 && ks[0] ? `${drm.scheme}:${ks[0].kid}:${ks[0].key}` : `${drm.scheme}:${ks.map((k) => `${k.kid}:${k.key}`).sort(cmp).join(",")}`;
  }
  return `${host}${portPart}${path}?${qPart}|${language}|${cameraAngle ?? ""}|${hasQParam || hasExplicitUrlQuality ? quality : "abr"}|${drmKey}`;
}

export function computeStreamScore(s: {
  protocol: StreamProtocol; height: number | null; bitrateBps: number | null; hlsVerified: boolean;
  drm: StreamDrm | null; headers: Record<string, string> | null; broadcasterGroup: string;
  providersCount?: number; providers?: ReadonlyArray<string>; needsProxy: boolean; probeFailed?: boolean; demoted?: boolean;
}, probeFailed?: boolean, demoted?: boolean): number {
  const pf = probeFailed ?? s.probeFailed, dm = demoted ?? s.demoted, pCount = s.providersCount ?? s.providers?.length ?? 1, h = s.height ?? 0;
  let score = 40 + (s.protocol === "hls" ? 18 : s.protocol === "dash" ? 12 : 6) + (s.hlsVerified ? 12 : 0) - (pf ? 28 : 0) - (dm ? 35 : 0)
    + (h >= 2160 ? 16 : h >= 1080 ? 14 : h >= 720 ? 10 : h >= 480 ? 5 : h > 0 ? 2 : 4) + Math.min(8, Math.max(0, pCount - 1) * 4);
  if (s.broadcasterGroup !== "General Sports") score += 4;
  score += !s.drm ? 4 : s.drm.scheme === "clearkey" && s.drm.keys?.length ? -2 : -8;
  if (!s.headers && !s.needsProxy) score += 2;
  if (s.bitrateBps && s.bitrateBps >= 4_000_000) score += 2;
  return Math.max(1, Math.min(100, Math.round(score)));
}

const detectProtocol = (lp: string, query: string): StreamProtocol =>
  lp.includes(".m3u8") || lp.includes("/hls/") || query.includes("format=m3u8") ? "hls"
    : lp.includes(".mpd") || lp.includes("/dash/") || query.includes("format=mpd") ? "dash" : "direct";

export class StreamEngine {
  static deduplicateAndRank(inputs: ReadonlyArray<RawProviderStreamInput>, proxyOrigin = "", isDemoted?: (url: string) => boolean): { streams: PlayableStream[]; audit: StreamAuditSummary } {
    const exclusions: StreamExclusion[] = [], byBaseKey = new Map<string, ParsedStreamCandidate[]>();
    const excl = (reason: StreamExclusion["reason"], provider: string, d: string) => exclusions.push({ reason, provider, details: d.slice(0, 80) });
    let validCount = 0;

    for (const { provider, stream } of inputs) {
      const uRaw = typeof stream.url === "string" ? stream.url : "", rawUrl = uRaw && (uRaw.charCodeAt(0) <= 32 || uRaw.charCodeAt(uRaw.length - 1) <= 32) ? uRaw.trim() : uRaw;
      const lm = parseStreamLabel(stream.name, stream.title);
      if (lm.isSpam) { excl("DONATION_SPAM", provider, stream.name || stream.title || rawUrl || stream.externalUrl || ""); continue; }
      if (!rawUrl) { const ext = typeof stream.externalUrl === "string" ? stream.externalUrl.trim() : ""; excl(ext ? "DONATION_SPAM" : "MISSING_URL", provider, stream.name || stream.title || ext); continue; }
      const p = parseFastHttpUrl(rawUrl);
      if (!p) { excl(SPAM_URL_RE.test(rawUrl) ? "DONATION_SPAM" : "INVALID_SCHEME", provider, rawUrl); continue; }
      if ((p.hostname === "cncverse.pages.dev" && p.pathname === "/") || (SPAM_URL_RE.test(rawUrl) && (SPAM_URL_RE.test(p.hostname) || SPAM_URL_RE.test(p.lowPath)))) { excl("DONATION_SPAM", provider, rawUrl); continue; }
      const lp = p.lowPath;
      if (!lp.endsWith(".m3u8") && !lp.endsWith(".mpd") && NON_MEDIA_EXT_RE.test(lp)) { excl("NON_MEDIA_URL", provider, p.pathname); continue; }

      const mayBridge = p.hostname.includes("cncverse") || lp.includes("/bridge") || lp.includes("/proxy") || lp.startsWith("/d/");
      const qp = parseQuerySinglePass(p.query, mayBridge);
      let org = p, bridged = false;
      if (mayBridge && qp.bridgeTarget && /^https?:\/\//.test(qp.bridgeTarget)) { const inner = parseFastHttpUrl(qp.bridgeTarget); if (inner) { org = inner; bridged = true; } }
      const outP = detectProtocol(lp, p.query), protocol: StreamProtocol = outP !== "direct" ? outP : bridged ? detectProtocol(org.lowPath, org.query) : "direct";

      let ch = lm.channel, bcKey = lm.bcKey;
      if (ch.group === "General Sports") { const inf = ChannelNormalizer.inferFromHostPath(org.hostname, org.lowPath); if (inf) { ch = inf; bcKey = slugify(ch.name); } }
      const lang = lm.lang ?? ChannelNormalizer.extractLanguageFromLowPath(org.lowPath), mh = qp.maxh ? parseInt(qp.maxh, 10) : 0, pQ = parseQualityFromText(org.lowPath);
      const pq = mh >= 144 && mh <= 4320 ? { quality: heightToLabel(mh), height: mh } : lm.labelQuality ? { quality: lm.labelQuality, height: lm.labelHeight } : pQ;
      const quality = pq.quality ?? "Auto", headers = sanitizeHeaders(stream.behaviorHints?.proxyHeaders?.request);
      let drm: StreamDrm | null = null;
      if (stream.clearkey || qp.clearkey) drm = DrmDetector.detect("", stream.clearkey, qp.clearkey) ?? DrmDetector.detect(`${stream.name ?? ""} ${stream.title ?? ""} ${rawUrl}`, stream.clearkey, qp.clearkey);
      else if (lm.drmHint || rawUrl.includes("clearkey") || rawUrl.includes("kid=")) drm = DrmDetector.detect(`${stream.name ?? ""} ${stream.title ?? ""} ${rawUrl}`);

      const baseKey = buildBaseKey(org, lang.code, lm.cameraAngle, quality, pQ.quality !== null, drm, qp.maxh, !mayBridge ? qp : undefined);
      validCount++;
      const cand: ParsedStreamCandidate = {
        provider, url: rawUrl, directOriginUrl: bridged ? org.href : null, originHost: org.hostname, protocol, broadcaster: ch.name, broadcasterGroup: ch.group, bcKey,
        cameraAngle: lm.cameraAngle, language: lang.code, languageName: lang.name, quality, height: pq.height, bitrateBps: lm.bitrateBps, headers, drm, baseKey, notWebReady: Boolean(stream.behaviorHints?.notWebReady),
      };
      const list = byBaseKey.get(baseKey);
      if (list) list.push(cand); else byBaseKey.set(baseKey, [cand]);
    }

    const groups: ParsedStreamCandidate[][] = [];
    for (const bucket of byBaseKey.values()) {
      if (bucket.length === 1) { groups.push(bucket); continue; }
      const byBc = new Map<string, ParsedStreamCandidate[]>();
      for (const c of bucket) { const a = byBc.get(c.bcKey); if (a) a.push(c); else byBc.set(c.bcKey, [c]); }
      if (byBc.size > 1 && byBc.has("generic")) {
        const gen = byBc.get("generic");
        byBc.delete("generic");
        let tk: string | null = null;
        for (const k of byBc.keys()) if (tk === null || cmp(k, tk) < 0) tk = k;
        const tl = tk ? byBc.get(tk) : undefined;
        if (gen && tl) for (const g of gen) tl.push(g);
      }
      for (const grp of byBc.values()) groups.push(grp);
    }

    const pfx = `${proxyOrigin}/api/proxy?url=`, playable: PlayableStream[] = [];
    for (const grp of groups) {
      if (grp.length > 1) {
        grp.sort((a, b) => (b.broadcasterGroup !== "General Sports" ? 1 : 0) - (a.broadcasterGroup !== "General Sports" ? 1 : 0)
          || (b.protocol === "hls" ? 3 : b.protocol === "dash" ? 2 : 1) - (a.protocol === "hls" ? 3 : a.protocol === "dash" ? 2 : 1)
          || (b.height ?? 0) - (a.height ?? 0) || cmp(a.provider, b.provider) || cmp(a.url, b.url));
      }
      const p0 = grp[0];
      if (!p0) continue;
      const providers = [p0.provider], mirrors: StreamMirror[] = [];
      let bH = p0.headers ? { ...p0.headers } : null, bDrm = p0.drm, bBr = p0.bitrateBps, bOrg = p0.directOriginUrl, bQ = p0.quality, bHt = p0.height;
      if (grp.length > 1) {
        const seenU = [p0.url], seenH = new Set<string>(bH ? Object.keys(bH).map((k) => k.toLowerCase()) : []);
        for (let i = 1; i < grp.length; i++) {
          const it = grp[i];
          if (!it) continue;
          if (!providers.includes(it.provider)) providers.push(it.provider);
          if (it.headers) for (const k in it.headers) { const v = it.headers[k], l = k.toLowerCase(); if (v && !seenH.has(l)) { seenH.add(l); (bH ??= {})[k] = v; } }
          if (!bDrm?.keys && it.drm?.keys) bDrm = it.drm;
          bBr ||= it.bitrateBps; bOrg ||= it.directOriginUrl;
          if (it.height !== null && (bHt === null || it.height > bHt)) { bHt = it.height; bQ = it.quality; }
          else if (bQ === "Auto" && it.quality !== "Auto") bQ = it.quality;
          if (!seenU.includes(it.url)) { seenU.push(it.url); mirrors.push({ provider: it.provider, url: it.url, protocol: it.protocol }); }
        }
        if (mirrors.length > 1) mirrors.sort((a, b) => cmp(a.provider, b.provider) || cmp(a.url, b.url));
        if (providers.length > 1) providers.sort(cmp);
      }
      const needsProxy = Boolean(bH) || p0.notWebReady || p0.url.startsWith("http://") || (p0.protocol === "hls" && !REPUTABLE_CDN_RE.test(p0.originHost));
      const sObj: PlayableStream = {
        id: `str_${stableHash(`${p0.baseKey}|${p0.bcKey}`)}`, rank: 0, score: 0, broadcaster: p0.broadcaster, broadcasterGroup: p0.broadcasterGroup,
        cameraAngle: p0.cameraAngle, protocol: p0.protocol, quality: bQ, height: bHt, bitrateBps: bBr, codecs: null, language: p0.language, languageName: p0.languageName,
        url: p0.url, directOriginUrl: bOrg, proxyUrl: `${pfx}${encodeURIComponent(p0.url)}${encodeHdrSuf(bH)}`, needsProxy,
        webPlayable: (p0.protocol === "hls" || p0.protocol === "dash") && (!bDrm || bDrm.scheme === "clearkey"),
        player: p0.protocol === "dash" ? "shaka" : p0.protocol === "hls" ? "hls.js" : TS_URL_RE.test(p0.url.toLowerCase()) ? "mpegts" : "native",
        headers: bH, drm: bDrm, hlsVerified: false, renditions: [], providers, mirrors,
      };
      sObj.score = computeStreamScore(sObj, false, isDemoted ? isDemoted(p0.url) : false);
      playable.push(sObj);
    }
    this.rankStreamsInPlace(playable);
    return { streams: playable, audit: { totalRaw: inputs.length, validCount, excludedCount: exclusions.length, exclusions } };
  }

  static applyHlsProbe(s: PlayableStream, probe: HlsProbeResult | null, demoted = false): void {
    if (!probe) { s.hlsVerified = false; s.score = computeStreamScore(s, true, demoted); return; }
    s.hlsVerified = probe.verified;
    if (probe.renditions.length) { s.renditions = probe.renditions; if (probe.renditions[0]?.codecs) s.codecs = probe.renditions[0].codecs; }
    if (probe.verified && probe.maxHeight) { s.height = probe.maxHeight; s.quality = heightToLabel(probe.maxHeight); }
    if (probe.verified && probe.maxBitrateBps) s.bitrateBps = probe.maxBitrateBps;
    s.score = computeStreamScore(s, false, demoted);
  }

  static rankStreamsInPlace(streams: PlayableStream[]): void {
    streams.sort((a, b) => b.score - a.score || (b.height ?? 0) - (a.height ?? 0) || b.providers.length - a.providers.length || cmp(a.id, b.id));
    for (let i = 0; i < streams.length; i++) { const s = streams[i]; if (s) s.rank = i + 1; }
  }
}
