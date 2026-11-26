import {
  CANONICAL_SPORTS, SPORT_LABELS, getExpectedDurationMinutes, getTaxonomy, type TournamentCluster,
} from "../data/taxonomy";
import type {
  EventDebugInfo, EventKind, EventStatus, EventSummary, EventTeam, MergeResolutionType,
} from "../types";
import { buildStableDiscriminator, EventIdentityEngine, type EventIdentity } from "./identity";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const MOJIBAKE_MARKER_RE = /Ã|Â|â€|ðŸ/;
const NON_ASCII_RE = /[^\x00-\x7f]/;
const CLEAN_DIRTY_RE = /[&\x80-\uffff\t\r\n]| {2}/;
const TITLE_NOISE_FAST_RE = /[:[\]]|live|stream/i;
const DIACRITICS_RE = /[\u0300-\u036f]/g;
const EMOJI_STRIP_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{200B}-\u{200F}\u{FE0F}\u{FEFF}]/gu;
const GENERIC_SPORT_RE = /^(?:tv|live|sports?|other|all|events?|channels?|featured|match|matches|general)$/i;
const TITLE_NOISE_RE = /\b(?:live\s*stream|live\s*now|watch\s*live|hd\s*stream|free\s*live)\b|\[(?:live|hd|fhd|uhd|4k|sd|sky\s*sports|tnt\s*sports|espn\+?|dazn|bein)\]|^\s*(?:sky\s*sports|tnt\s*sports|espn\+?|dazn|bein\s*sports)\s*:\s*/gi;
const TEAM_SUFFIX_STRIP_RE = /\b(?:f\.?c\.?|c\.?f\.?|s\.?c\.?|a\.?f\.?c\.?|u\.?d\.?|c\.?d\.?|s\.?d\.?|s\.?v\.?|f\.?k\.?|vfl|1\.\s*fc|s\.?s\.?c\.?)\b/gi;
const TEAM_QUALIFIER_STRIP_RE = /[\s-]+(?:women'?s?|womens|femenino|f[eé]minin|frauen|men'?s?|mens|under[\s-]*(?:17|19|20|21|23)|u[\s-]*(?:17|19|20|21|23)|reserves?|2nd\s*xi|second\s*xi)\b|-w\b|[\s-]+a$/gi;
const TEAM_BRACKET_RE = /\([^)]*\)|\[[^\]]*\]/g;
const ACRONYM_DOTS_RE = /\b([a-zA-Z])\.([a-zA-Z])\.([a-zA-Z])\.?\b/g;
const UTD_EXPAND_RE = /\butd\.?(?=\s|$)/gi;
const VS_SPLIT_RE = /\s+(?:vs\.?|v\.?|@|x)\s+/i;
const TRAILING_MATCH_TAG_RE = /\s+(?:match|game|leg)\s*#?\d{1,3}$/i;
const CIRCUIT_STRIP_RE = /\b(?:f1|formula\s*1|formula\s*one|motogp|moto\s*gp|grand\s*prix|gp|fp[123]|free\s*practice\s*\d?|practice\s*\d?|sprint\s*(?:shootout|qualifying|race)?|qualifying|main\s*race|race\s*day|race|session|live|20\d{2})\b/gi;
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#(\d+)|#x([0-9a-fA-F]+));/gi;
const CRICKET_OVERRIDE_RE = /\b(?:f1|formula\s*1|motogp|nba|nhl|nfl|ufc|premier\s*league|champions\s*league|la\s*liga)\b/i;
const CLUSTER_FAST_RE = /npl|nepal|dhabi|wbbl|bash|ilt|friday|one\s+(?:fighting\s+)?championship|raw|smackdown|nxt|f1|formula|motogp|moto|red\s*zone|redzone|stockholm|dynamite|collision|isl|indian\s*super|evento/i;

const SPORTS_DAY_ROLLOVER_MS = 4 * 3_600_000;

const TZ_OFFSETS_MIN: Record<string, number> = Object.create(null);
for (const e of "UTC:0,GMT:0,Z:0,BST:60,CET:60,CEST:120,EET:120,EEST:180,SAST:120,AST:180,GST:240,PKT:300,IST:330,NPT:345,SGT:480,JST:540,AEST:600,AEDT:660,NZST:720,NZDT:780,EST:-300,EDT:-240,CST:-360,CDT:-300,MST:-420,MDT:-360,PST:-480,PDT:-420,BRT:-180,ART:-180".split(",")) {
  const [k, v] = e.split(":");
  if (k && v) TZ_OFFSETS_MIN[k] = parseInt(v, 10);
}
const MONTH_INDEX: Record<string, number> = Object.create(null);
"jan|january,feb|february,mar|march,apr|april,may,jun|june,jul|july,aug|august,sep|sept|september,oct|october,nov|november,dec|december"
  .split(",").forEach((g, idx) => { for (const k of g.split("|")) MONTH_INDEX[k] = idx; });

const POSTER_KEY_SLOT: Record<string, number> = Object.create(null);
"team1|teamA|t1|home|team1Name,team2|teamB|t2|away|team2Name,title|match|name,league|tournament|eventName|competition,sport|category|cat,startTime|start|time|date|kickoff,teamAImg|logo1|flag1|team1Logo|teamALogo|t1Logo,teamBImg|logo2|flag2|team2Logo|teamBLogo|t2Logo,eventLogo|leagueLogo|compLogo,isLive|status|live,isEnded"
  .split(",").forEach((g, idx) => { for (const k of g.split("|")) POSTER_KEY_SLOT[k] = idx; });

const INDIVIDUAL_SPORTS = new Set("tennis|combat|table_tennis|badminton|snooker|darts|golf".split("|"));
const GENERIC_CLUB_TOKENS = new Set(
  "united|city|fc|cf|sc|ac|as|cd|rc|sk|bk|fk|sv|ss|us|ud|sd|ssc|vfl|vfb|afc|cfc|rfc|sfc|real|sporting|athletic|atletico|club|team|national|royal|super|kings|lions|rangers|giants|stars|eagles|tigers|wolves|rovers|wanderers|albion|town|county".split("|")
);
const ISO_LIKE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5}))?$/i;
const DMY_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5}))?$/i;
const TEXT_DATE_RE = /^(?:(\d{1,2})\s+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2})),?\s*(\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5}))?$/i;
const QUALITY_RANK: Record<string, number> = Object.assign(Object.create(null), { "4K": 2160, "1440p": 1440, "1080p": 1080, "720p": 720, "540p": 540, "480p": 480, "396p": 396, "360p": 360 });
const AGE_DISPLAY_RE: Record<string, RegExp> = Object.assign(Object.create(null), {
  u17: /(?:u|under)[\s-]*17\b/i, u19: /(?:u|under)[\s-]*19\b/i, u20: /(?:u|under)[\s-]*20\b/i, u21: /(?:u|under)[\s-]*21\b/i, u23: /(?:u|under)[\s-]*23\b/i,
});
const HTML_ENT_MAP: Record<string, string> = Object.assign(Object.create(null), {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'", "&nbsp;": " ",
});

const MAX_MEMO = 8192;
const teamNormBySport = new Map<string, Map<string, { name: string; slug: string }>>();
const slugMemo = new Map<string, string>();
const dateMemo = new Map<string, number | null>();
const dayBucketMemo = new Map<number, string>();
const isoMemo = new Map<number, string>();
const sportMemo = new Map<string, string>();
const sportFilterMemo = new Map<string, string | null>();
const tourneySportMemo = new Map<string, string>();
const tourneyRawMemo = new Map<string, string>();
const tourneyFallbackMemo = new Map<string, string>();
const teamCodeMemo = new Map<string, string>();
const cleanTextMemo = new Map<string, string>();
const cleanTitleMemo = new Map<string, string>();
const clubKeyMemo = new Map<string, string[]>();

const memo = <V>(m: Map<string, V>, k: string, maxLen: number, fn: () => V, cap = MAX_MEMO): V => {
  if (k.length > maxLen) return fn();
  const hit = m.get(k);
  return hit !== undefined ? hit : memoSet(m, k, fn(), cap);
};
export const hasCricketOverride = (s?: string | null): boolean => Boolean(s && CRICKET_OVERRIDE_RE.test(s));
export const memoSet = <K, V>(m: Map<K, V>, k: K, v: V, max = MAX_MEMO): V => { if (m.size >= max) m.clear(); m.set(k, v); return v; };
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isoFromMs = (ms: number | null): string | null => (ms === null ? null : isoMemo.get(ms) ?? memoSet(isoMemo, ms, new Date(ms).toISOString()));
const fold = (s: string): string => (NON_ASCII_RE.test(s) ? s.normalize("NFD").replace(DIACRITICS_RE, "") : s);
const ws = (s: string): string => s.replace(/\s+/g, " ").trim();
const trimFast = (s: string): string => (s.charCodeAt(0) <= 32 || s.charCodeAt(s.length - 1) <= 32 ? s.trim() : s);

export function scanQueryParams(qs: string, onPair: (rawKey: string, rawVal: string, hasEq: boolean) => void): void {
  for (let pos = 0, len = qs.length; pos < len;) {
    const amp = qs.indexOf("&", pos), end = amp === -1 ? len : amp;
    if (end > pos) {
      const eq = qs.indexOf("=", pos), hasEq = eq !== -1 && eq < end;
      onPair(qs.slice(pos, hasEq ? eq : end), hasEq ? qs.slice(eq + 1, end) : "", hasEq);
    }
    pos = end + 1;
  }
}

export interface PosterMetadata {
  teamA: string | null; teamB: string | null; teamALogo: string | null; teamBLogo: string | null;
  competitionLogo: string | null; title: string | null; tournament: string | null; sport: string | null;
  startTimeRaw: string | null; isLive: boolean; isEnded: boolean;
}

export interface NormalizedCandidateInput {
  provider: string; providerIndex?: number; sourceIndex?: number; rawId: string; title: string; tournament: string; sport: string; kind: EventKind;
  teams: [string, string] | null; teamSlugs: [string, string] | null; rawTeams: [string, string] | null;
  teamALogo: string | null; teamBLogo: string | null; competitionLogo: string | null;
  poster: string | null; banner: string | null; startMs: number | null; endMs: number | null;
  isLiveFlag: boolean; isEndedFlag: boolean; isHot: boolean; identity: EventIdentity;
  broadcasters: string[]; languages: string[]; maxQualityHint: string | null; streamHintCount: number;
  canonicalKey: string; pairSlug: string | null; dateBucket: string;
}

export interface ParticipantMatchResult { matched: boolean; reversed: boolean; conflict: "CONFLICTING_PARTICIPANT_INITIAL" | null; }

export function stableHash(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + ((i & 0xff) << 1)), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${((h2 >>> 0) & 0xffff).toString(16).padStart(4, "0")}`;
}

function utcMs(y: number, m1: number, d: number, hr: number, min: number, sec: number): number {
  const yr = m1 <= 2 ? y - 1 : y, era = Math.floor(yr / 400), yoe = yr - era * 400;
  const doy = Math.floor((153 * (m1 + (m1 > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return (era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468) * 86_400_000 + hr * 3_600_000 + min * 60_000 + sec * 1_000;
}

export function dayBucketFromMs(ms: number | null): string {
  if (ms === null) return "nodate";
  const day = Math.floor(ms / 86_400_000);
  return dayBucketMemo.get(day) ?? memoSet(dayBucketMemo, day, new Date(day * 86_400_000).toISOString().slice(0, 10), 128);
}

export const sportsDayBucketFromMs = (ms: number | null): string => (ms === null ? "nodate" : dayBucketFromMs(ms - SPORTS_DAY_ROLLOVER_MS));

export const decodeHtmlEntities = (s: string): string => (!s || !s.includes("&") ? s : s.replace(HTML_ENTITY_RE, (m, d?: string, h?: string) => {
  if (d || h) { const c = parseInt(d ?? h ?? "", d ? 10 : 16); return c >= 32 && c <= 0x10ffff ? String.fromCodePoint(c) : m; }
  return HTML_ENT_MAP[m.toLowerCase()] ?? m;
}));

export function repairMojibake(s: string): string {
  if (!s || !MOJIBAKE_MARKER_RE.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c > 255) return s; bytes[i] = c; }
  try { return UTF8_DECODER.decode(bytes); } catch { return s; }
}

function forEachAlnumToken(input: string, cb: (tok: string) => void): void {
  const s = fold(input).toLowerCase();
  for (let i = 0, st = -1, n = s.length; i <= n; i++) {
    const c = i < n ? s.charCodeAt(i) : 0;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { if (st === -1) st = i; }
    else if (st !== -1) { cb(s.slice(st, i)); st = -1; }
  }
}

export function slugify(input: string): string {
  if (!input) return "";
  if (input.length <= 96) { const hit = slugMemo.get(input); if (hit !== undefined) return hit; }
  let out = "";
  forEachAlnumToken(input, (t) => { out = out ? `${out}-${t}` : t; });
  return input.length <= 96 ? memoSet(slugMemo, input, out) : out;
}

export function cleanText(input?: string | null): string {
  if (!input) return "";
  if (!CLEAN_DIRTY_RE.test(input)) return trimFast(input);
  return memo(cleanTextMemo, input, 96, () => {
    let f = input.includes("&") ? decodeHtmlEntities(input) : input;
    if (NON_ASCII_RE.test(f)) {
      f = repairMojibake(f);
      for (let i = 0; i < f.length; i++) if (f.charCodeAt(i) >= 0x200b) { f = f.replace(EMOJI_STRIP_RE, " "); break; }
    }
    return ws(f);
  });
}

export function cleanTitle(input?: string | null): string {
  if (!input) return "";
  return memo(cleanTitleMemo, input, 96, () => {
    const base = cleanText(input);
    if (!base) return "";
    const s = TITLE_NOISE_FAST_RE.test(base) ? ws(base.replace(TITLE_NOISE_RE, " ")) : base;
    if (!s) return "";
    const ok = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    return ok(s.charCodeAt(0)) && ok(s.charCodeAt(s.length - 1)) ? s : s.replace(/^[-:|•·\s]+|[-:|•·\s]+$/g, "");
  });
}

export function normalizeSportFilter(raw?: string | null): string | null {
  if (!raw) return null;
  return memo(sportFilterMemo, raw, 48, () => {
    const t = trimFast(raw);
    if (!t) return null;
    const low = t.toLowerCase(), key = low.includes(" ") ? low.replace(/\s+/g, "_") : low, al = getTaxonomy().sportFilterAliases;
    return SPORT_LABELS[key] ? key : GENERIC_SPORT_RE.test(key) ? null : al[key] ?? al[key.replace(/_/g, "")] ?? null;
  }, 512);
}

export const getSportLabel = (sport: string): string =>
  SPORT_LABELS[sport] ?? (sport ? sport.charAt(0).toUpperCase() + sport.slice(1).replace(/_/g, " ") : "Sports");

const inYearRange = (ms: number): number | null => (Number.isFinite(ms) && ms > 946684800000 && ms < 4102444800000 ? ms : null);

function applyDateTime(y: number, m: number, d: number, hrS?: string, minS?: string, secS?: string, ap?: string, tz?: string): number | null {
  let hr = hrS ? parseInt(hrS, 10) : 0, tzMin = 0;
  const mer = ap?.toUpperCase();
  if (mer === "PM" && hr < 12) hr += 12;
  if (mer === "AM" && hr === 12) hr = 0;
  if (tz) {
    const u = tz.trim().toUpperCase(), mapped = TZ_OFFSETS_MIN[u];
    if (mapped !== undefined) tzMin = mapped;
    else { const om = /^([+-])(\d{2}):?(\d{2})$/.exec(u); if (om?.[1] && om[2] && om[3]) tzMin = (om[1] === "-" ? -1 : 1) * (+om[2] * 60 + +om[3]); }
  }
  return inYearRange(utcMs(y, m, d, hr, minS ? parseInt(minS, 10) : 0, secS ? parseInt(secS, 10) : 0) - tzMin * 60_000);
}

function fastIsoUtcMs(s: string): number | null {
  const len = s.length, sep = s.charCodeAt(10);
  if (len < 19 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45 || s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58 ||
    (sep !== 84 && sep !== 32) || (len > 19 && s.charCodeAt(len - 1) !== 90 && !(len === 23 && s.endsWith(" UTC")))) return null;
  const d2 = (i: number) => (s.charCodeAt(i) - 48) * 10 + (s.charCodeAt(i + 1) - 48);
  const y = d2(0) * 100 + d2(2), mo = d2(5), dy = d2(8), hr = d2(11), mi = d2(14), sc = d2(17);
  return y < 2000 || y > 2099 || mo < 1 || mo > 12 || dy < 1 || dy > 31 || hr > 23 || mi > 59 || sc > 59 ? null : inYearRange(utcMs(y, mo, dy, hr, mi, sc));
}

export function parseDateTimeMs(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return input > 0 ? inYearRange(input < 1e12 ? input * 1000 : input) : null;
  const t = trimFast(input);
  if (!t) return null;
  return memo(dateMemo, t, 48, () => {
    const fast = fastIsoUtcMs(t);
    if (fast !== null) return fast;
    let m: RegExpExecArray | null;
    if (/^\d{9,13}$/.test(t)) { const n = Number(t); return inYearRange(n < 1e12 ? n * 1000 : n); }
    if ((m = ISO_LIKE_RE.exec(t)) && m[1] && m[2] && m[3]) return applyDateTime(+m[1], +m[2], +m[3], m[4], m[5], m[6], undefined, m[7]);
    if ((m = DMY_RE.exec(t)) && m[1] && m[2] && m[3]) return applyDateTime(+m[3], +m[2], +m[1], m[4], m[5], m[6], m[7], m[8]);
    if ((m = TEXT_DATE_RE.exec(t)) && m[5]) {
      const ds = m[1] ?? m[4], mo = MONTH_INDEX[(m[2] ?? m[3] ?? "").toLowerCase()];
      if (ds && mo !== undefined) return applyDateTime(+m[5], mo + 1, +ds, m[6], m[7], m[8], m[9], m[10]);
    }
    return inYearRange(Date.parse(t));
  });
}

export function decodeQueryVal(raw: string): string {
  const s = raw.includes("+") ? raw.replace(/\+/g, " ") : raw;
  if (!s.includes("%")) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

export function extractPosterParams(url?: string | null): PosterMetadata | null {
  const qIdx = url ? url.indexOf("?") : -1;
  if (qIdx === -1 || !url) return null;
  const hIdx = url.indexOf("#", qIdx + 1), q = url.slice(qIdx + 1, hIdx === -1 ? url.length : hIdx);
  if (!q) return null;
  const s: Array<string | null> = [null, null, null, null, null, null, null, null, null];
  let isLive = false, isEnded = false, any = false;
  scanQueryParams(q, (k, v, eq) => {
    const sl = eq && v ? POSTER_KEY_SLOT[k] : undefined;
    if (sl === undefined) return;
    if (sl === 9) { if (/^(?:live|true|1)$/i.test(v)) isLive = any = true; }
    else if (sl === 10) { if (/^(?:true|1)$/i.test(v)) isEnded = any = true; }
    else if (!s[sl]) {
      const d = decodeQueryVal(v).trim();
      const val = sl >= 6 ? (/^https?:\/\//.test(d) ? d : null) : d && d.toLowerCase() !== "null" ? cleanText(d) : null;
      if (val) { s[sl] = val; any = true; }
    }
  });
  if (!any) return null;
  let title = s[2] ?? null, tournament = s[3] ?? null;
  if (!tournament && title && s[0] && s[1] && !VS_SPLIT_RE.test(title)) { tournament = title; title = null; }
  return { teamA: s[0] ?? null, teamB: s[1] ?? null, title, tournament, sport: s[4] ?? null, startTimeRaw: s[5] ?? null, teamALogo: s[6] ?? null, teamBLogo: s[7] ?? null, competitionLogo: s[8] ?? null, isLive, isEnded };
}

export function normalizeTeamWithSlug(raw: string, sport?: string): { name: string; slug: string } {
  const sp = sport ?? "";
  let byRaw = teamNormBySport.get(sp);
  if (raw.length <= 72 && byRaw) { const hit = byRaw.get(raw); if (hit) return hit; }
  const name = normalizeTeamNameUncached(raw, sport), res = { name, slug: slugify(name) };
  if (raw.length <= 72) { if (!byRaw) teamNormBySport.set(sp, (byRaw = new Map())); memoSet(byRaw, raw, res); }
  return res;
}

export const normalizeTeamName = (raw: string, sport?: string): string => normalizeTeamWithSlug(raw, sport).name;

function normalizeTeamNameUncached(raw: string, sport?: string): string {
  const base = cleanText(raw);
  if (!base) return "";
  const { contextualTeams, teamAliases } = getTaxonomy();
  const hit = (s: string) => { const l = s.toLowerCase(); return (sport ? contextualTeams[sport]?.[l] : undefined) ?? teamAliases[l]; };
  const c = base.includes("(") || base.includes("[") || base.includes(".") ? ws(base.replace(TEAM_BRACKET_RE, " ").replace(ACRONYM_DOTS_RE, "$1$2$3")) : base;
  const st = c ? ws(c.replace(TEAM_QUALIFIER_STRIP_RE, " ")) : "";
  let nc = st ? ws(st.replace(TEAM_SUFFIX_STRIP_RE, " ")) : "";
  if (nc && UTD_EXPAND_RE.test(nc)) nc = nc.replace(UTD_EXPAND_RE, "United");
  return hit(base) ?? (c && c !== base ? hit(c) : undefined) ?? (st && st !== c ? hit(st) : undefined)
    ?? (nc ? hit(nc) ?? (NON_ASCII_RE.test(nc) ? teamAliases[fold(nc).toLowerCase()] : undefined) : undefined) ?? (nc || st || c);
}

export const teamCode = (name: string): string => memo(teamCodeMemo, name, 96, () => {
  const w = fold(name).replace(/[^A-Za-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  return !w.length ? "TBD" : w.length === 1 ? (w[0] ?? "").slice(0, 3).toUpperCase()
    : w.length === 2 ? `${(w[0] ?? "").slice(0, 2)}${(w[1] ?? "").slice(0, 1)}`.toUpperCase()
    : w.slice(0, 3).map((x) => x[0] ?? "").join("").toUpperCase();
});

export function parseTeamsFromTitle(title: string, alreadyClean = false): [string, string] | null {
  if (!title) return null;
  let w = alreadyClean ? title : cleanTitle(title);
  for (const [sep, after] of [[":", true], [" - ", true], [" | ", false]] as const) {
    const i = after ? w.indexOf(sep) : w.lastIndexOf(sep);
    if (i > 0) { const sub = after ? w.slice(i + sep.length) : w.slice(0, i); if (VS_SPLIT_RE.test(sub)) w = sub.trim(); }
  }
  const p = w.split(VS_SPLIT_RE);
  if (p.length !== 2) return null;
  const a = (p[0] ?? "").trim(), b = (p[1] ?? "").replace(TRAILING_MATCH_TAG_RE, "").trim();
  return !a || !b || a.length > 64 || b.length > 64 || /^(?:t10|t20|red\s*zone|stockholm\s*open|live)$/i.test(b) ? null : [a, b];
}

export function matchTournamentCluster(text: string): TournamentCluster | null {
  if (!text || !CLUSTER_FAST_RE.test(text)) return null;
  const { clusterTriggers, clusters } = getTaxonomy();
  let mask = 0, found: TournamentCluster | null = null;
  forEachAlnumToken(text, (tok) => {
    if (found) return;
    for (const idx of clusterTriggers.get(tok) ?? []) {
      const bit = 1 << idx;
      if ((mask & bit) !== 0) continue;
      mask |= bit;
      const cl = clusters[idx];
      if (cl?.regex.test(text)) { found = cl; return; }
    }
  });
  return found;
}

function isCricketNation(raw: string): boolean {
  const { cricketNations: cn } = getTaxonomy(), low = raw.toLowerCase();
  if (cn.has(low)) return true;
  const t: string[] = [];
  forEachAlnumToken(low, (x) => t.push(x));
  return t.some((x, i) => cn.has(x) || (i + 1 < t.length && cn.has(`${x} ${t[i + 1] ?? ""}`)) || (i + 2 < t.length && cn.has(`${x} ${t[i + 1] ?? ""} ${t[i + 2] ?? ""}`)));
}

function scanSportTokens(text: string): string {
  const { sportUni, sportBi, sportTri, sportBiFirst, sportTriFirst } = getTaxonomy();
  let best = "other", rank = 999, p2 = "", p1 = "", p1B = false, p2T = false;
  const take = (e?: { sport: string; rank: number }) => { if (e && e.rank < rank) { rank = e.rank; best = e.sport; } };
  forEachAlnumToken(text, (tok) => {
    if (rank === 0) return;
    take(sportUni.get(tok));
    if (p1B) take(sportBi.get(`${p1} ${tok}`));
    if (p2T) take(sportTri.get(`${p2} ${p1} ${tok}`));
    p2 = p1; p2T = Boolean(p1 && sportTriFirst.has(p1)); p1 = tok; p1B = sportBiFirst.has(tok);
  });
  return best;
}

export function classifySport(rawSport: string | null | undefined, tourney: string, title: string, rawTeams: [string, string] | null, prov?: string): string {
  const exp = normalizeSportFilter(rawSport);
  if (exp && (exp !== "cricket" || (!CRICKET_OVERRIDE_RE.test(tourney) && !CRICKET_OVERRIDE_RE.test(title)))) return exp;
  if (tourney && tourney.length <= 96) {
    const ts = memo(tourneySportMemo, tourney, 96, () => scanSportTokens(tourney));
    if (ts !== "other" && (ts !== "cricket" || !CRICKET_OVERRIDE_RE.test(title))) return ts;
  }
  const comb = rawTeams ? `${tourney} ${title} ${rawTeams[0]} ${rawTeams[1]}` : `${tourney} ${title}`;
  return memo(sportMemo, `${prov ?? ""}\0${comb}`, 240, () => {
    let best = scanSportTokens(comb);
    if (best === "other" && (/(?:u19|under-?19)\s*(?:asia\s*cup|world\s*cup)/i.test(comb) ||
      (rawTeams && isCricketNation(rawTeams[0]) && isCricketNation(rawTeams[1]) && (prov === "cricify" || /\b(?:series|tour|cup|trophy|warm-?up|rising\s*stars)\b/i.test(comb))))) best = "cricket";
    return best;
  });
}

export function normalizeTournamentName(raw: string, sport: string, title: string, alreadyClean = false): string {
  if (raw && raw.length <= 96) {
    const hit = tourneyRawMemo.get(raw);
    if (hit !== undefined) return hit;
    const c = alreadyClean ? raw : cleanText(raw);
    if (c && !GENERIC_SPORT_RE.test(c)) return memoSet(tourneyRawMemo, raw, matchTournamentCluster(c)?.displayName ?? c);
  }
  return memo(tourneyFallbackMemo, `${sport}\0${title}`, 110, () => matchTournamentCluster(title)?.displayName ?? getSportLabel(sport));
}

function buildClusterOrShowKey(sport: string, tourney: string, title: string, day: string, disc: string, sess: string | null, fmt: string | null, is24x7: boolean): { key: string; kind: EventKind } {
  const cl = matchTournamentCluster(`${tourney} ${title}`);
  if (cl) {
    return {
      key: cl.splitBySession ? `${cl.canonicalKey}::${slugify(`${title} ${tourney}`.replace(CIRCUIT_STRIP_RE, " ")) || "event"}::${sess ?? fmt ?? "session"}::${day}` : `${cl.canonicalKey}::${day}`,
      kind: cl.splitBySession ? "session" : cl.kind,
    };
  }
  return { key: `${sport}::${slugify(title) || slugify(tourney) || "event"}::${day}${disc ? `::${disc}` : ""}`, kind: is24x7 ? "channel" : sport === "motorsport" ? "session" : "show" };
}

export function computeCanonicalKey(sport: string, teams: [string, string] | null, id: EventIdentity, tourney: string, title: string, startMs: number | null, preSlugs?: [string, string] | null) {
  const dateBucket = dayBucketFromMs(startMs), disc = id.canonicalDiscriminator;
  if (id.is24x7Channel && !teams) return { key: `${sport}::${slugify(title) || slugify(tourney) || "channel"}::channel`, kind: "channel" as EventKind, pairSlug: null, dateBucket };
  if (teams) {
    const a = preSlugs ? preSlugs[0] : slugify(teams[0]), b = preSlugs ? preSlugs[1] : slugify(teams[1]);
    if (a && b && a !== b) {
      const pairSlug = a < b ? `${a}-vs-${b}` : `${b}-vs-${a}`;
      return { key: `${sport}::${pairSlug}::${dateBucket}${disc ? `::${disc}` : ""}`, kind: "match" as EventKind, pairSlug, dateBucket };
    }
  }
  return { ...buildClusterOrShowKey(sport, tourney, title, dateBucket, disc, id.session, id.format, id.is24x7Channel), pairSlug: null, dateBucket };
}

export function computeLifecycleStatus(sport: string, fmt: string | null, startMs: number | null, endMs: number | null, anyLive: boolean, allEnded: boolean, nowMs: number): EventStatus {
  const expMs = getExpectedDurationMinutes(sport, fmt) * 60_000;
  const grace = sport === "cricket" && fmt === "test" ? 7_200_000 : sport === "tennis" || sport === "combat" ? 5_400_000 : 2_700_000;
  if ((endMs !== null && nowMs > endMs + 1_800_000) || (startMs !== null && nowMs > startMs + expMs + grace) || (allEnded && !anyLive)) return "ended";
  if (anyLive) return startMs !== null && startMs - nowMs > 7_200_000 ? "upcoming" : "live";
  if (startMs !== null && nowMs >= startMs - 900_000 && (endMs === null || nowMs <= endMs)) return "live";
  return allEnded ? "ended" : "upcoming";
}

const nameParts = (n: string): string[] => fold(n).toLowerCase().replace(/[^a-z\s]/g, " ").trim().split(/\s+/).filter(Boolean);
export const extractParticipantSurname = (n: string): string => { const p = nameParts(n); return p[p.length - 1] ?? ""; };

function matchSingleParticipant(a: string, b: string): "exact" | "surname" | "conflict" | "none" {
  const sA = slugify(a), sB = slugify(b);
  if (!sA || !sB) return "none";
  if (sA === sB) return "exact";
  const pA = nameParts(a), pB = nameParts(b), sur = pA[pA.length - 1] ?? "";
  if (sur.length < 3 || sur !== (pB[pB.length - 1] ?? "")) return "none";
  const iA = pA.length > 1 ? pA[0]?.[0] : null, iB = pB.length > 1 ? pB[0]?.[0] : null;
  return iA && iB && iA !== iB ? "conflict" : "surname";
}

export function areParticipantsCompatible(a: [string, string], b: [string, string], sport: string): ParticipantMatchResult {
  if (INDIVIDUAL_SPORTS.has(sport)) {
    for (const rev of [false, true]) {
      const m0 = matchSingleParticipant(a[0], b[rev ? 1 : 0]), m1 = matchSingleParticipant(a[1], b[rev ? 0 : 1]);
      if (m0 === "conflict" || m1 === "conflict") return { matched: false, reversed: rev, conflict: "CONFLICTING_PARTICIPANT_INITIAL" };
      if (m0 !== "none" && m1 !== "none") return { matched: true, reversed: rev, conflict: null };
    }
  }
  return { matched: false, reversed: false, conflict: null };
}

const clubInitials = (toks: string[], skip1: boolean): string => toks.reduce((a, t) => (!skip1 || t.length > 1 ? a + (t[0] ?? "") : a), "");

export const extractClubIndexKeys = (slug: string): string[] => memo(clubKeyMemo, slug, 96, () => {
  const toks = slug.split("-").filter(Boolean), keys = toks.filter((t) => t.length >= 2 && !GENERIC_CLUB_TOKENS.has(t));
  if (toks.length >= 2 && toks.length <= 5) {
    const all = clubInitials(toks, false), sig = clubInitials(toks, true);
    keys.push(all);
    if (sig.length >= 2 && sig !== all) keys.push(sig);
    if (sig.length >= 3) keys.push(sig.slice(0, -1));
  }
  return keys;
}, 4096);

function matchSingleClub(a: string, b: string, preA?: string, preB?: string): boolean {
  const sA = preA ?? slugify(a), sB = preB ?? slugify(b);
  if (!sA || !sB) return false;
  if (sA === sB) return true;
  const tA = sA.split("-").filter(Boolean), tB = sB.split("-").filter(Boolean);
  if (!tA.length || !tB.length) return false;
  const chk = (raw: string, tok: string, long: string[]): boolean => {
    if (long.length >= 2 && tok.length >= 2 && tok.length <= 4 && !GENERIC_CLUB_TOKENS.has(tok) && long[0] === tok && (tok.length >= 3 || raw.trim() === raw.trim().toUpperCase())) return true;
    if (tok.length < 2 || tok.length > 5 || long.length < tok.length) return false;
    if (clubInitials(long, false) === tok) return true;
    const sig = clubInitials(long, true);
    return sig.startsWith(tok) && sig.length <= tok.length + 1;
  };
  if ((tA.length === 1 && tA[0] && chk(a, tA[0], tB)) || (tB.length === 1 && tB[0] && chk(b, tB[0], tA))) return true;
  const [sm, lg] = tA.length <= tB.length ? [tA, tB] : [tB, tA];
  return sm.every((t) => lg.includes(t)) && sm.some((t) => t.length >= 4 && !GENERIC_CLUB_TOKENS.has(t));
}

export const areClubsCompatible = (a: [string, string], b: [string, string], sA?: [string, string] | null, sB?: [string, string] | null): { matched: boolean; reversed: boolean } =>
  matchSingleClub(a[0], b[0], sA?.[0], sB?.[0]) && matchSingleClub(a[1], b[1], sA?.[1], sB?.[1]) ? { matched: true, reversed: false }
    : matchSingleClub(a[0], b[1], sA?.[0], sB?.[1]) && matchSingleClub(a[1], b[0], sA?.[1], sB?.[0]) ? { matched: true, reversed: true }
    : { matched: false, reversed: false };

function formatDisplayTeamName(name: string, raws: ReadonlyArray<string>, id: Pick<EventIdentity, "squad" | "ageGroup" | "gender">): string {
  const low = name.toLowerCase(), ageRe = id.ageGroup ? AGE_DISPLAY_RE[id.ageGroup] : undefined;
  if (id.squad === "a_team" && !low.endsWith(" a") && !low.includes("lions") && raws.some((r) => /[\s-]+a\b/i.test(r))) return `${name} A`;
  if (id.ageGroup && ageRe && !low.includes(id.ageGroup) && raws.some((r) => ageRe.test(r))) return `${name} ${id.ageGroup.toUpperCase()}`;
  return id.gender === "women" && !low.includes("women") && raws.some((r) => /\bwomen|-w\b|femenino/i.test(r)) ? `${name} Women` : name;
}

export function cascadeEvent(
  canonicalKey: string, items: ReadonlyArray<NormalizedCandidateInput>, mergeType: MergeResolutionType,
  mergeConfidence: number, mergeSignals: string[], nowMs: number, fmtOverride?: string | null
): { event: EventSummary; debug: EventDebugInfo; providers: string[]; startMs: number | null; endMs: number | null } {
  let sorted = items;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    if (a && b && (a.provider > b.provider || (a.provider === b.provider && a.rawId > b.rawId))) {
      sorted = [...items].sort((x, y) => cmp(x.provider, y.provider) || cmp(x.rawId, y.rawId));
      break;
    }
  }
  let sport = sorted[0]?.sport ?? "other", kind: EventKind = "show", hasS = false, hasC = false;
  let sportCounts: Map<string, number> | null = null;
  let fmt: string | null = fmtOverride ?? null, sess: string | null = null, mNum: string | null = null, stg: string | null = null;
  let gender: "men" | "women" | null = null, age: string | null = null, squad: string | null = null, isDbl = false, is24x7 = true;
  let prim: NormalizedCandidateInput | null = null, primLen = -1;
  const teamBest = new Map<string, { name: string; logo: string | null }>();
  let compLogo: string | null = null, startMs: number | null = null, endMs: number | null = null;
  let anyLive = false, allEnded = true, isHot = false, poster: string | null = null, banner: string | null = null;
  let bestQ: string | null = null, bestQR = 0, sCount = 0;
  const provPtr: Record<string, string> = {}, provIds: Record<string, string[]> = {}, providers: string[] = [], bcs: string[] = [], langs: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    if (!it) continue;
    if (it.sport !== sport && !sportCounts) { sportCounts = new Map(); if (i) sportCounts.set(sport, sport === "other" ? 0 : i); }
    if (sportCounts) sportCounts.set(it.sport, (sportCounts.get(it.sport) ?? 0) + (it.sport === "other" ? 0 : 1));
    if (it.kind === "match") kind = "match"; else if (it.kind === "session") hasS = true; else if (it.kind === "channel") hasC = true;
    const ii = it.identity;
    fmt ||= ii.format; sess ||= ii.session; mNum ||= ii.matchNumber; stg ||= ii.stage; age ||= ii.ageGroup; squad ||= ii.squad;
    if (ii.gender === "women") gender = "women"; else if (!gender && ii.gender === "men") gender = "men";
    if (ii.isDoubles) isDbl = true;
    if (!ii.is24x7Channel) is24x7 = false;
    if (it.teams) {
      const [tA, tB] = it.teams, sA = it.teamSlugs?.[0] ?? slugify(tA), sB = it.teamSlugs?.[1] ?? slugify(tB);
      if (tA.length + tB.length > primLen) { primLen = tA.length + tB.length; prim = it; }
      for (const [sl, nm, lg] of [[sA, tA, it.teamALogo], [sB, tB, it.teamBLogo]] as const) {
        const cur = teamBest.get(sl);
        if (!cur) teamBest.set(sl, { name: nm, logo: lg });
        else { if (nm.length > cur.name.length) cur.name = nm; cur.logo ||= lg; }
      }
    }
    compLogo ||= it.competitionLogo; poster ||= it.poster; banner ||= it.banner;
    if (it.startMs !== null && (startMs === null || it.startMs < startMs)) startMs = it.startMs;
    if (it.endMs !== null && (endMs === null || it.endMs > endMs)) endMs = it.endMs;
    if (it.isLiveFlag) anyLive = true;
    if (!it.isEndedFlag) allEnded = false;
    if (it.isHot) isHot = true;
    if (it.maxQualityHint) { const r = QUALITY_RANK[it.maxQualityHint] ?? 0; if (r > bestQR) { bestQR = r; bestQ = it.maxQualityHint; } }
    const rl = provIds[it.provider];
    if (!rl) { provPtr[it.provider] = it.rawId; provIds[it.provider] = [it.rawId]; providers.push(it.provider); }
    else if (!rl.includes(it.rawId)) rl.push(it.rawId);
    for (const x of it.broadcasters) if (!bcs.includes(x)) bcs.push(x);
    for (const x of it.languages) if (!langs.includes(x)) langs.push(x);
    sCount += it.streamHintCount;
  }

  if (kind !== "match") kind = hasS ? "session" : hasC ? "channel" : "show";
  if (sportCounts && sportCounts.size > 1) {
    let top = -1;
    for (const [s, c] of [...sportCounts.entries()].sort((a, b) => cmp(a[0], b[0]))) if (c > top) { top = c; sport = s; }
  }
  const sLab = getSportLabel(sport);
  let compName = "", bestTitle = "";
  for (const it of sorted) {
    if (it.tournament && it.tournament !== sLab && (!compName || it.tournament.length > compName.length || (it.tournament.length === compName.length && it.tournament < compName))) compName = it.tournament;
    if (!prim && it.title && (!bestTitle || it.title.length > bestTitle.length || (it.title.length === bestTitle.length && it.title < bestTitle))) bestTitle = it.title;
  }
  compName ||= sorted[0]?.tournament || sLab;

  let teamsObj: { home: EventTeam; away: EventTeam } | null = null;
  if (prim?.teams) {
    const [rH, rA] = prim.teams, hSlug = prim.teamSlugs?.[0] ?? slugify(rH), aSlug = prim.teamSlugs?.[1] ?? slugify(rA);
    const h = teamBest.get(hSlug) ?? { name: rH, logo: null }, a = teamBest.get(aSlug) ?? { name: rA, logo: null };
    let dH = h.name, dA = a.name;
    if (squad === "a_team" || age || gender === "women") {
      const rawH: string[] = [], rawA: string[] = [];
      for (const it of sorted) {
        if (!it.teams) continue;
        const s0 = it.teamSlugs?.[0] ?? slugify(it.teams[0]), s1 = it.teamSlugs?.[1] ?? slugify(it.teams[1]);
        if (s0 === hSlug) rawH.push(it.rawTeams?.[0] ?? it.teams[0]); else if (s0 === aSlug) rawA.push(it.rawTeams?.[0] ?? it.teams[0]);
        if (s1 === aSlug) rawA.push(it.rawTeams?.[1] ?? it.teams[1]); else if (s1 === hSlug) rawH.push(it.rawTeams?.[1] ?? it.teams[1]);
      }
      dH = formatDisplayTeamName(h.name, rawH, { squad, ageGroup: age, gender });
      dA = formatDisplayTeamName(a.name, rawA, { squad, ageGroup: age, gender });
    }
    teamsObj = { home: { id: hSlug, name: dH, code: teamCode(h.name), logo: h.logo }, away: { id: aSlug, name: dA, code: teamCode(a.name), logo: a.logo } };
  }

  const sDisc = buildStableDiscriminator({ gender, ageGroup: age, squad, isDoubles: isDbl, session: sess, stage: stg, matchNumber: mNum, format: fmt }, sport);
  const sDay = sportsDayBucketFromMs(startMs);
  const idKey = teamsObj
    ? `${sport}::${teamsObj.home.id < teamsObj.away.id ? `${teamsObj.home.id}-vs-${teamsObj.away.id}` : `${teamsObj.away.id}-vs-${teamsObj.home.id}`}::${sDay}${sDisc ? `::${sDisc}` : ""}`
    : kind === "channel" && is24x7 ? canonicalKey : buildClusterOrShowKey(sport, compName, bestTitle, sDay, sDisc, sess, fmt, is24x7).key;
  const id = `evt_${stableHash(idKey)}`, pCount = providers.length;
  if (bcs.length > 1) bcs.sort(cmp);
  if (langs.length > 1) langs.sort(cmp);
  return {
    event: {
      id, kind, status: computeLifecycleStatus(sport, fmt, startMs, endMs, anyLive, allEnded, nowMs), sport,
      title: teamsObj ? `${teamsObj.home.name} vs ${teamsObj.away.name}` : bestTitle || compName,
      startAt: isoFromMs(startMs), endAt: isoFromMs(endMs), hot: isHot || pCount >= 3,
      competition: { id: slugify(compName) || sport, name: compName, logo: compLogo }, teams: teamsObj,
      details: fmt || sess || mNum || stg || gender || age || squad ? { format: fmt, session: sess, matchNumber: mNum, stage: stg, gender, ageGroup: age, squad } : null,
      poster, banner, broadcasters: bcs, languages: langs, providerCount: pCount, streamCount: Math.max(sCount, pCount || 1),
      maxQuality: bestQ, hasDrmFree: true, hasWebPlayable: true, streamsUrl: `/api/stream/${id}`,
    },
    debug: { canonicalKey, providerPointers: provPtr, providerRawIds: provIds, mergeType, mergeConfidence, mergeSignals: mergeSignals.length <= 1 ? mergeSignals : [...new Set(mergeSignals)].sort(cmp) },
    providers, startMs, endMs,
  };
}

export { CANONICAL_SPORTS, EventIdentityEngine };
