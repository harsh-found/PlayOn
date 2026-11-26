/**
 * Pure, zero-dependency unencrypted MPEG-DASH (.mpd) -> HLS v7 fMP4 (.m3u8) converter.
 * Supports SegmentTemplate+SegmentTimeline, fixed-duration SegmentTemplate (live & VOD),
 * and SegmentList. Rejects DRM-protected manifests with 422 DASH_DRM_UNSUPPORTED.
 */

export interface DashToHlsOptions {
  repId?: string | null;
  nowMs: number;
  formatPlaylistUrl: (repId: string) => string;
  formatMediaUrl: (resolvedUrl: string) => string;
  isAllowedUrl?: (href: string) => boolean;
}

export type DashToHlsResult =
  | { ok: true; m3u8: string; isLive: boolean; trackCount: number }
  | { ok: false; status: number; code: "DASH_DRM_UNSUPPORTED" | "DASH_INVALID_MPD" | "DASH_TRACK_NOT_FOUND"; detail: string };

interface SegTemplate {
  timescale: number;
  duration: number;
  startNumber: number;
  initialization?: string;
  media?: string;
  timeline?: Array<{ t?: number; d: number; r: number }>;
}

interface SegList {
  initialization?: string;
  duration: number;
  timescale: number;
  startNumber: number;
  urls: string[];
}

interface DashRep {
  id: string;
  templateId: string;
  kind: "video" | "audio";
  bandwidth: number;
  width: number;
  height: number;
  frameRate?: string;
  codecs?: string;
  lang?: string;
  baseUrl: string;
  template?: SegTemplate;
  list?: SegList;
}

const DRM_SCHEME_RE = /mp4protection|edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95|e2719d58-a985-b3c9-781a-b030af78d30e|1077efec-c0b2-4d02-ace3-3c1e52e2fb4b|94ce86fb-07ff-4f43-adb8-93d2fa968ca2|widevine|playready|clearkey|fairplay|cenc/i;
const MAX_VOD_SEGMENTS = 3_600;
const LIVE_WINDOW_SEGMENTS = 10;

const unescXml = (s: string): string =>
  s.includes("&")
    ? s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m) => {
        const l = m.toLowerCase();
        if (l === "&amp;") return "&";
        if (l === "&lt;") return "<";
        if (l === "&gt;") return ">";
        if (l === "&quot;") return '"';
        if (l === "&apos;") return "'";
        if (l.startsWith("&#x")) return String.fromCodePoint(parseInt(l.slice(3, -1), 16));
        return String.fromCodePoint(parseInt(l.slice(2, -1), 10));
      })
    : s;

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const k = m[1];
    if (k) out[k] = unescXml(m[2] ?? m[3] ?? "");
  }
  return out;
}

function findDirectBlocks(xml: string, tagName: string): Array<{ attrs: Record<string, string>; body: string }> {
  const out: Array<{ attrs: Record<string, string>; body: string }> = [];
  const openRe = new RegExp(`<${tagName}\\b([^>]*?)(\\/?)>`, "gi");
  const closeToken = `</${tagName}`;
  let pos = 0;
  while (pos < xml.length) {
    openRe.lastIndex = pos;
    const m = openRe.exec(xml);
    if (!m) break;
    const attrs = parseAttrs(m[1] ?? "");
    if (m[2] === "/") {
      out.push({ attrs, body: "" });
      pos = openRe.lastIndex;
      continue;
    }
    const startBody = openRe.lastIndex;
    const endIdx = xml.toLowerCase().indexOf(closeToken.toLowerCase(), startBody);
    if (endIdx === -1) break;
    const closeGt = xml.indexOf(">", endIdx);
    if (closeGt === -1) break;
    out.push({ attrs, body: xml.slice(startBody, endIdx) });
    pos = closeGt + 1;
  }
  return out;
}

function extractFirstBaseUrl(xml: string, parentUrl: string): string {
  const m = /<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i.exec(xml);
  if (!m?.[1]) return parentUrl;
  const raw = unescXml(m[1].trim());
  if (!raw) return parentUrl;
  try {
    return new URL(raw, parentUrl).href;
  } catch {
    return parentUrl;
  }
}

function stripChildTags(xml: string, childTag: string): string {
  return xml.replace(new RegExp(`<${childTag}\\b[\\s\\S]*?(?:<\\/${childTag}>|\\/>)`, "gi"), "");
}

export function parseIsoDurationSec(iso?: string): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(iso.trim());
  if (!m) return null;
  const sec = (Number(m[1] ?? 0) * 86_400) + (Number(m[2] ?? 0) * 3_600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

export function isDashManifest(text: string): boolean {
  const head = text.slice(0, 1024);
  return /<MPD\b/i.test(head);
}

function hasDrmProtection(xml: string): boolean {
  const cps = findDirectBlocks(xml, "ContentProtection");
  for (const cp of cps) {
    const scheme = cp.attrs.schemeIdUri ?? "";
    const val = cp.attrs.value ?? "";
    if (DRM_SCHEME_RE.test(scheme) || DRM_SCHEME_RE.test(val) || /cenc:default_KID|pssh/i.test(cp.body) || cp.attrs["cenc:default_KID"]) {
      return true;
    }
  }
  return false;
}

function parseSegmentTemplate(xml: string, inherit?: SegTemplate): SegTemplate | undefined {
  const blocks = findDirectBlocks(xml, "SegmentTemplate");
  const blk = blocks[0];
  if (!blk) return inherit;
  const a = blk.attrs;
  let timeline = inherit?.timeline;
  const tl = findDirectBlocks(blk.body, "SegmentTimeline")[0];
  if (tl) {
    timeline = [];
    for (const s of findDirectBlocks(tl.body, "S")) {
      const d = Number(s.attrs.d ?? 0);
      if (d > 0) {
        timeline.push({
          t: s.attrs.t !== undefined ? Number(s.attrs.t) : undefined,
          d,
          r: s.attrs.r !== undefined ? Number(s.attrs.r) : 0,
        });
      }
    }
  }
  return {
    timescale: Number(a.timescale ?? inherit?.timescale ?? 1) || 1,
    duration: Number(a.duration ?? inherit?.duration ?? 0),
    startNumber: Number(a.startNumber ?? inherit?.startNumber ?? 1),
    initialization: a.initialization ?? inherit?.initialization,
    media: a.media ?? inherit?.media,
    timeline,
  };
}

function parseSegmentList(xml: string, inherit?: SegList): SegList | undefined {
  const blk = findDirectBlocks(xml, "SegmentList")[0];
  if (!blk) return inherit;
  const a = blk.attrs;
  const initBlk = findDirectBlocks(blk.body, "Initialization")[0];
  const urls = findDirectBlocks(blk.body, "SegmentURL").map((u) => u.attrs.media ?? "").filter(Boolean);
  return {
    initialization: initBlk?.attrs.sourceURL ?? inherit?.initialization,
    duration: Number(a.duration ?? inherit?.duration ?? 0),
    timescale: Number(a.timescale ?? inherit?.timescale ?? 1) || 1,
    startNumber: Number(a.startNumber ?? inherit?.startNumber ?? 1),
    urls: urls.length ? urls : (inherit?.urls ?? []),
  };
}

function expandDashTemplate(tpl: string, repId: string, bandwidth: number, num: number, time: number): string {
  return tpl.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$|\$\$/g, (m, name: string | undefined, pad: string | undefined) => {
    if (m === "$$") return "$";
    if (name === "RepresentationID") return repId;
    if (name === "Bandwidth") return String(bandwidth);
    if (name === "Number" || name === "Time") {
      const v = String(name === "Number" ? num : time);
      return pad ? v.padStart(Number(pad), "0") : v;
    }
    return m;
  });
}

function resolveSafe(rel: string, base: string, isAllowed?: (href: string) => boolean): string | null {
  try {
    const href = new URL(rel, base).href;
    return !isAllowed || isAllowed(href) ? href : null;
  } catch {
    return null;
  }
}

function parseFps(raw?: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(Number);
    if (a && b && b > 0) return (a / b).toFixed(3).replace(/\.?0+$/, "");
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n.toFixed(3).replace(/\.?0+$/, "") : null;
}

export function convertDashToHls(xml: string, manifestUrl: string, opts: DashToHlsOptions): DashToHlsResult {
  const mpdOpen = /<MPD\b([^>]*)>/i.exec(xml);
  if (!mpdOpen) return { ok: false, status: 422, code: "DASH_INVALID_MPD", detail: "Upstream response is not a valid MPEG-DASH MPD." };
  if (hasDrmProtection(xml)) {
    return {
      ok: false, status: 422, code: "DASH_DRM_UNSUPPORTED",
      detail: "DRM-encrypted DASH manifests cannot be converted to HLS on edge. Only unencrypted DASH is supported.",
    };
  }

  const mpdAttrs = parseAttrs(mpdOpen[1] ?? "");
  const isLive = (mpdAttrs.type ?? "static").toLowerCase() === "dynamic";
  const mpdDurationSec = parseIsoDurationSec(mpdAttrs.mediaPresentationDuration);
  const availStartMs = mpdAttrs.availabilityStartTime ? Date.parse(mpdAttrs.availabilityStartTime) : NaN;
  const mpdBase = extractFirstBaseUrl(stripChildTags(xml, "Period"), manifestUrl);

  const periods = findDirectBlocks(xml, "Period");
  const period = periods[periods.length - 1];
  if (!period) return { ok: false, status: 422, code: "DASH_INVALID_MPD", detail: "MPD contains no <Period> elements." };
  const periodStartSec = parseIsoDurationSec(period.attrs.start) ?? 0;
  const periodDurSec = parseIsoDurationSec(period.attrs.duration) ?? mpdDurationSec;
  const periodBase = extractFirstBaseUrl(stripChildTags(period.body, "AdaptationSet"), mpdBase);

  const reps: DashRep[] = [];
  const usedIds = new Set<string>();
  let seqId = 0;
  for (const aset of findDirectBlocks(period.body, "AdaptationSet")) {
    const aa = aset.attrs;
    const asetHead = stripChildTags(aset.body, "Representation");
    const asetBase = extractFirstBaseUrl(asetHead, periodBase);
    const asetTpl = parseSegmentTemplate(asetHead);
    const asetList = parseSegmentList(asetHead);

    for (const r of findDirectBlocks(aset.body, "Representation")) {
      const ra = r.attrs;
      const mime = (ra.mimeType ?? aa.mimeType ?? "").toLowerCase();
      const cType = (aa.contentType ?? "").toLowerCase();
      const kind: "video" | "audio" | null =
        cType === "video" || mime.startsWith("video/") || ra.width || ra.height ? "video"
          : cType === "audio" || mime.startsWith("audio/") ? "audio" : null;
      if (!kind) continue;

      const template = parseSegmentTemplate(r.body, asetTpl);
      const list = parseSegmentList(r.body, asetList);
      if (!template?.media && !list?.urls.length) continue;

      const rawId = ra.id || `${kind}_${++seqId}`;
      let uniqueId = rawId;
      if (usedIds.has(uniqueId)) uniqueId = `${kind[0]}:${rawId}`;
      if (usedIds.has(uniqueId)) uniqueId = `${kind[0]}:${rawId}_${++seqId}`;
      usedIds.add(uniqueId);

      reps.push({
        id: uniqueId,
        templateId: rawId,
        kind,
        bandwidth: Number(ra.bandwidth ?? 0) || (kind === "video" ? 1_500_000 : 128_000),
        width: Number(ra.width ?? aa.width ?? 0),
        height: Number(ra.height ?? aa.height ?? 0),
        frameRate: ra.frameRate ?? aa.frameRate,
        codecs: ra.codecs ?? aa.codecs,
        lang: aa.lang || undefined,
        baseUrl: extractFirstBaseUrl(r.body, asetBase),
        template,
        list,
      });
    }
  }

  if (!reps.length) return { ok: false, status: 422, code: "DASH_INVALID_MPD", detail: "MPD contains no convertible audio or video representations." };

  const videos = reps.filter((r) => r.kind === "video").sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const audios = reps.filter((r) => r.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth);

  // Master Playlist
  if (!opts.repId) {
    const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
    const audioGroup = audios.length > 0 && videos.length > 0 ? "aud" : null;
    if (audioGroup) {
      audios.forEach((a, idx) => {
        const lang = a.lang ?? "und";
        const name = a.lang ? `${a.lang.toUpperCase()} (${Math.round(a.bandwidth / 1000)}k)` : `Audio ${idx + 1}`;
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${idx === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="${opts.formatPlaylistUrl(a.id)}"`
        );
      });
    }
    const primary = videos.length ? videos : audios;
    const defaultAudioCodec = audios[0]?.codecs;
    for (const v of primary) {
      const attrs: string[] = [`BANDWIDTH=${v.bandwidth}`];
      if (v.width > 0 && v.height > 0) attrs.push(`RESOLUTION=${v.width}x${v.height}`);
      const fps = parseFps(v.frameRate);
      if (fps) attrs.push(`FRAME-RATE=${fps}`);
      const codecs = v.codecs && defaultAudioCodec && audioGroup && !v.codecs.includes(",") ? `${v.codecs},${defaultAudioCodec}` : v.codecs;
      if (codecs) attrs.push(`CODECS="${codecs}"`);
      if (audioGroup) attrs.push(`AUDIO="${audioGroup}"`);
      lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, opts.formatPlaylistUrl(v.id));
    }
    return { ok: true, m3u8: `${lines.join("\n")}\n`, isLive, trackCount: primary.length + (audioGroup ? audios.length : 0) };
  }

  // Media Playlist for a single Representation
  const rep = reps.find((r) => r.id === opts.repId);
  if (!rep) return { ok: false, status: 404, code: "DASH_TRACK_NOT_FOUND", detail: `Representation '${opts.repId}' not found in MPD.` };

  const segments: Array<{ seq: number; dur: number; url: string }> = [];
  let initHref: string | null = null;

  if (rep.template?.media) {
    const t = rep.template, mediaTpl = rep.template.media;
    if (t.initialization) {
      const rawInit = expandDashTemplate(t.initialization, rep.templateId, rep.bandwidth, t.startNumber, 0);
      initHref = resolveSafe(rawInit, rep.baseUrl, opts.isAllowedUrl);
    }
    if (t.timeline?.length) {
      let curTime = 0;
      let segNum = t.startNumber;
      const expanded: Array<{ seq: number; time: number; dur: number }> = [];
      for (const entry of t.timeline) {
        if (entry.t !== undefined) curTime = entry.t;
        let count: number;
        if (entry.r < 0) {
          const endSec = isLive && Number.isFinite(availStartMs)
            ? Math.max(0, (opts.nowMs - availStartMs) / 1000 - periodStartSec)
            : periodDurSec;
          const curSec = curTime / t.timescale;
          const remSec = endSec !== null && endSec > curSec ? endSec - curSec : 0;
          const derived = remSec > 0 ? Math.floor((remSec * t.timescale) / entry.d) : (isLive ? LIVE_WINDOW_SEGMENTS : 1);
          count = Math.max(1, Math.min(derived, MAX_VOD_SEGMENTS - expanded.length));
        } else {
          count = Math.min(entry.r + 1, MAX_VOD_SEGMENTS - expanded.length);
        }
        for (let k = 0; k < count && expanded.length < MAX_VOD_SEGMENTS; k++) {
          expanded.push({ seq: segNum++, time: curTime, dur: entry.d / t.timescale });
          curTime += entry.d;
        }
      }
      const slice = isLive && expanded.length > LIVE_WINDOW_SEGMENTS ? expanded.slice(-LIVE_WINDOW_SEGMENTS) : expanded;
      for (const seg of slice) {
        const href = resolveSafe(expandDashTemplate(mediaTpl, rep.templateId, rep.bandwidth, seg.seq, seg.time), rep.baseUrl, opts.isAllowedUrl);
        if (href) segments.push({ seq: seg.seq, dur: seg.dur, url: href });
      }
    } else if (t.duration > 0) {
      const segDur = t.duration / t.timescale;
      let firstSeq = t.startNumber;
      let count = LIVE_WINDOW_SEGMENTS;
      if (isLive && Number.isFinite(availStartMs)) {
        const elapsedSec = Math.max(0, (opts.nowMs - availStartMs) / 1000 - periodStartSec);
        const edgeSeq = t.startNumber + Math.max(0, Math.floor(elapsedSec / segDur) - 1);
        firstSeq = Math.max(t.startNumber, edgeSeq - LIVE_WINDOW_SEGMENTS + 1);
        count = edgeSeq - firstSeq + 1;
      } else if (!isLive && periodDurSec && periodDurSec > 0) {
        count = Math.min(MAX_VOD_SEGMENTS, Math.max(1, Math.ceil(periodDurSec / segDur)));
      }
      for (let i = 0; i < count; i++) {
        const seq = firstSeq + i;
        const href = resolveSafe(expandDashTemplate(mediaTpl, rep.templateId, rep.bandwidth, seq, (seq - t.startNumber) * t.duration), rep.baseUrl, opts.isAllowedUrl);
        if (href) segments.push({ seq, dur: segDur, url: href });
      }
    }
  } else if (rep.list?.urls.length) {
    const l = rep.list;
    if (l.initialization) initHref = resolveSafe(l.initialization, rep.baseUrl, opts.isAllowedUrl);
    const dur = l.duration > 0 ? l.duration / l.timescale : 4;
    const urls = isLive && l.urls.length > LIVE_WINDOW_SEGMENTS ? l.urls.slice(-LIVE_WINDOW_SEGMENTS) : l.urls.slice(0, MAX_VOD_SEGMENTS);
    const offset = l.urls.length - urls.length;
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      if (!u) continue;
      const href = resolveSafe(u, rep.baseUrl, opts.isAllowedUrl);
      if (href) segments.push({ seq: l.startNumber + offset + i, dur, url: href });
    }
  }

  if (!segments.length) return { ok: false, status: 422, code: "DASH_INVALID_MPD", detail: "No playable media segments could be derived from MPD." };

  let maxDur = 1;
  for (const s of segments) if (s.dur > maxDur) maxDur = s.dur;
  const mediaSeq = segments[0]?.seq ?? 0;
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDur))}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  if (initHref) lines.push(`#EXT-X-MAP:URI="${opts.formatMediaUrl(initHref)}"`);
  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.dur.toFixed(3)},`, opts.formatMediaUrl(seg.url));
  }
  if (!isLive) lines.push("#EXT-X-ENDLIST");
  return { ok: true, m3u8: `${lines.join("\n")}\n`, isLive, trackCount: 1 };
}
