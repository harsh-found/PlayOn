import { memoSet } from "./normalizer";

export interface NormalizedChannel { name: string; group: string; }
export interface LanguageInfo { code: string; name: string; }

export const ENGLISH_LANG: LanguageInfo = { code: "eng", name: "English" };

const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{200B}-\u{200F}\u{FE0F}\u{FEFF}]/gu;
const TECH_TOKEN_RE = /\b(?:direct\s*\d*p|direct|\d+p|\d+k|~?[\d.]+\s*(?:mbps|kbps)|uhd|fhd|hd|sd|aq|alt|ad-?free)\b/gi;
const SPAM_TRAILER_RE = /(?:buffer-free|join\s+telegram|t\.me\/|cncverse\s+bridge|stream\s+provided\s+by|donate|paypal|patreon|audio:\s*\w+|\(plays\s+in\s+mpv\)|\(recommended\)).*$/gim;
const PROVIDER_NOISE_RE = /\b(?:sportzx|playztv|livxow|sktech|playfy|cricify)\s*(?:provider)?\b/gi;
const GENERIC_SERVER_RE = /^(?:(?:sd|hd|low|backup)\s+server(?:\s+\S+)*|low(?:\s+quality)?|server(?:\s+\S+)*|stream\s*\d+|live|sk\s+live)$/i;
const BROADCASTER_HINT_RE = /\b(?:sky|sony|fancode|willow|star|supersport|bein|tnt|dazn|tapmad|ptv|eurosport|astro|tamasha|prime|icc\s*tv|espn|fox|kayo|stan|optus|premier\s*sports|viaplay|xtreme|tsn|sportsnet|jio|hotstar|redzone|nba|nhl|nfl|vix|sportv|eleven|spotv|sp0tv|auvio|sbs|apple\s*tv|ten\s*sport|paramount)\b/i;
const FAST_BROADCASTER_DIRTY_RE = /https?:|donate|telegram|t\.me|audio:|server\s*\d|stream\s*\d/i;
const BITRATE_STRIP_RE = /\s*~?[\d.]+\s*(?:mbps|kbps)/gi;

const BARE_LANGUAGES = new Set("hindi|english|tamil|telugu|kannada|bengali|malayalam|marathi|gujarati|punjabi|urdu|spanish|arabic|french|portuguese|german|italian|russian".split("|"));
const SS_SUBS = "CRICKET|GRANDSTAND|PREMIER|RUGBY|TENNIS|ACTION|FOOTBALL|VARIETY".split("|");
const NUM_BROADCASTERS: ReadonlyArray<readonly [string, RegExp, string, string, string]> = [
  ["TSN", /\bTSN\s*([1-5])\b/, "TSN ", "TSN HD", "TSN"],
  ["TNT", /\b([1-4])\b/, "TNT Sports ", "TNT Sports HD", "TNT Sports"],
  ["BT SPORT", /\b([1-4])\b/, "TNT Sports ", "TNT Sports HD", "TNT Sports"],
  ["EUROSPORT", /\b([12])\b/, "Eurosport ", "Eurosport HD", "Eurosport"],
  ["DAZN", /\b([12])\b/, "DAZN ", "DAZN HD", "DAZN"],
  ["SPORTV", /\b([23])\b/, "SporTV ", "SporTV Brasil", "SporTV"],
];
const REGEX_BROADCASTERS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bPRIME(?:\s+(?:VIDEO|ENG|ENGLISH|HIN|HINDI|TAM|TAMIL|TEL|TELUGU|KAN|KANNADA|LIVE|SPORTS?))?\b|AMAZON PRIME/, "Amazon Prime Video", "Amazon Prime"],
  [/ICC[.\s]?TV/, "ICC.tv", "ICC TV"], [/A[\s-]SPORTS/, "A Sports HD", "A Sports"], [/T[\s-]SPORTS/, "T Sports HD", "T Sports"],
  [/\bNFL(?:\s*(?:LIVE|NETWORK|TV))?\b/, "NFL Network", "NFL Network"], [/\bNBA(?:\s*(?:LIVE|TV|USA))?\b/, "NBA TV", "NBA TV"],
  [/\bNHL(?:\s*(?:LIVE|NETWORK|TV))?\b/, "NHL Network", "NHL Network"], [/TENNIS CHANNEL|^TENNIS\s*\d*$/, "Tennis Channel", "Tennis Channel"],
  [/\bVIX\b/, "ViX Deportes", "ViX"], [/\bSPORT\s*1\b/, "Sport1 Germany", "Sport1"], [/\bCANAL\s*(?:\+|(?:5|SPORT)\b)|^CANAL5$/, "Canal+ Sport", "Canal+"],
];

const URL_SPEC = "sonymtmnew|Sony LIV|Sony Sports Network;slivcdn.com|Sony LIV|Sony Sports Network;sonyliv|Sony LIV|Sony Sports Network;sonyeventsglobal|Sony LIV|Sony Sports Network;fancode|FanCode|FanCode;tapmad.com|Tapmad Live|Tapmad;tamashaweb.com|Tamasha Live|Tamasha;msnetworks.net/ptv|PTV Sports|PTV Sports;msnetworks.net/a-sports|A Sports HD|A Sports;icctv|ICC.tv|ICC TV";
const SIMPLE_SPEC = "PARAMOUNT|Paramount+|Paramount+;FANCODE|FanCode|FanCode;FAN CODE|FanCode|FanCode;TAPMAD|Tapmad Live|Tapmad;TAMASHA|Tamasha Live|Tamasha;PTV|PTV Sports|PTV Sports;REDZONE|NFL RedZone|NFL Network;RED ZONE|NFL RedZone|NFL Network;LEAGUE PASS|NBA League Pass|NBA TV;ELEVEN SPORT|Eleven Sports|Eleven Sports;SPOTV|SPOTV HD|SPOTV;SP0TV|SPOTV HD|SPOTV;AUVIO|RTBF Auvio|RTBF;SBS SPORT|SBS Sports|SBS Sports;STAN SPORT|Stan Sport|Stan Sport;OPTUS|Optus Sport|Optus Sport;PREMIER SPORT|Premier Sports|Premier Sports;VIAPLAY|Viaplay Sports|Viaplay;XTREME|Xtreme+ Live|Xtreme+;SPORTSNET|Sportsnet HD|Sportsnet;HOTSTAR|Disney+ Hotstar|Star Sports";
const SKY_SPEC = "MAIN EVENT|Main Event;TOP EVENT|Main Event;CRICKET|Cricket;FOOTBALL|Football;F1|F1;FORMULA 1|F1;TENNIS|Tennis;PREMIER|Premier League;GOLF|Golf;ACTION|Action;ARENA|Arena;MIX|Mix";
const FLAG_SPEC = "🇪🇸|spa;🇲🇽|spa;🇦🇷|spa;🇸🇦|ara;🇦🇪|ara;🇶🇦|ara;🇪🇬|ara;🇫🇷|fra;🇧🇪|fra;🇧🇷|por;🇵🇹|por;🇩🇪|deu;🇦🇹|deu;🇮🇹|ita;🇷🇺|rus";
const LANG_SPEC = "hin:Hindi:hin|hindi;tam:Tamil:tam|tamil;tel:Telugu:tel|telugu;kan:Kannada:kan|kannada;ben:Bengali:ben|bengali|bangla;mal:Malayalam:mal|malayalam;mar:Marathi:mar|marathi;guj:Gujarati:guj|gujarati;pun:Punjabi:pun|punjabi;urd:Urdu:urd|urdu;spa:Spanish:spa|spanish|espanol|español|deportes|esp;ara:Arabic:ara|arabic;fra:French:fra|french|francais|français|auvio;por:Portuguese:por|portuguese|portugues|português|brasil;deu:German:deu|ger|german|deutsch;ita:Italian:ita|italian|italiano|italia;rus:Russian:rus|russian";

interface ChannelTables {
  urlRules: Array<[string, string, string]>;
  simpleBc: Array<[string, string, string]>;
  skySubs: Array<[string, string]>;
  flagRules: Array<[string, string]>;
  langMap: Map<string, LanguageInfo>;
  pairOk: Uint8Array;
}

let tablesCache: ChannelTables | null = null;
const split3 = (s: string) => s.split(";").map((r) => r.split("|") as [string, string, string]);
const split2 = (s: string) => s.split(";").map((r) => r.split("|") as [string, string]);

function ensureTables(): ChannelTables {
  if (tablesCache) return tablesCache;
  const langMap = new Map<string, LanguageInfo>(), pairOk = new Uint8Array(676);
  for (const row of LANG_SPEC.split(";")) {
    const [code = "", name = "", toks = ""] = row.split(":");
    const info: LanguageInfo = { code, name };
    for (const t of toks.split("|")) {
      langMap.set(t, info);
      const c0 = t.charCodeAt(0) - 97, c1 = t.charCodeAt(1) - 97;
      if (c0 >= 0 && c0 < 26 && c1 >= 0 && c1 < 26) pairOk[c0 * 26 + c1] = 1;
    }
  }
  return (tablesCache = { urlRules: split3(URL_SPEC), simpleBc: split3(SIMPLE_SPEC), skySubs: split2(SKY_SPEC), flagRules: split2(FLAG_SPEC), langMap, pairOk });
}

const MAX_MEMO = 4096;
const channelMemo = new Map<string, NormalizedChannel>();
const langTextMemo = new Map<string, LanguageInfo | null>();
const langUrlMemo = new Map<string, LanguageInfo | null>();

function scanLangTokens(s: string, to: number, urlMode: boolean): LanguageInfo | null {
  const { langMap: map, pairOk } = ensureTables();
  for (let i = 0, start = -1, hasUp = false; i <= to; i++) {
    const raw = i < to ? s.charCodeAt(i) : 0, isUp = urlMode && raw >= 65 && raw <= 90, c = isUp ? raw | 32 : raw;
    if ((c >= 97 && c <= 122) || (!urlMode && c > 127)) {
      if (start === -1) { start = i; hasUp = isUp; } else if (isUp) hasUp = true;
    } else if (start !== -1) {
      const tLen = i - start;
      if (tLen >= 3 && tLen <= 10) {
        const prev = urlMode && start > 0 ? s.charCodeAt(start - 1) : 47;
        if (!urlMode || prev === 47 || prev === 95 || prev === 45) {
          const a = (s.charCodeAt(start) | 32) - 97, b = (s.charCodeAt(start + 1) | 32) - 97;
          if (a >= 0 && a < 26 && b >= 0 && b < 26 && pairOk[a * 26 + b]) {
            const sub = s.slice(start, i), hit = map.get(hasUp ? sub.toLowerCase() : sub);
            if (hit) return hit;
          }
        }
      } else if (urlMode && tLen === 2 && i + 3 <= to && s.charCodeAt(i) === 45 &&
        (s.charCodeAt(start) | 32) === 112 && (s.charCodeAt(start + 1) | 32) === 116 &&
        (s.charCodeAt(i + 1) | 32) === 98 && (s.charCodeAt(i + 2) | 32) === 114) {
        return map.get("por") ?? null;
      }
      start = -1;
    }
  }
  return null;
}

function scanLangText(str: string): LanguageInfo | null {
  if (!str) return null;
  const { langMap: map, flagRules } = ensureTables();
  if (str.includes("\uD83C")) for (const [flag, code] of flagRules) if (str.includes(flag)) return map.get(code) ?? null;
  const low = str.toLowerCase();
  if (low.includes("pt-br") || (low.includes("sportv") && /\bbr\b/.test(low))) return map.get("por") ?? null;
  if (low.includes("sport 1 de") || low.includes("sport1 de")) return map.get("deu") ?? null;
  return low.includes("russia feed") ? map.get("rus") ?? null : scanLangTokens(low, low.length, false);
}

function matchBroadcaster(u: string): NormalizedChannel | null {
  const { skySubs, simpleBc } = ensureTables();
  const has = (s: string) => u.includes(s), mk = (name: string, group: string): NormalizedChannel => ({ name, group });
  if (has("APPLE") && has("TV")) return mk("Apple TV+", "Apple TV+");
  if (has("SONY") || has("TEN")) {
    if (has("SONYLIV") || (has("SONY") && has("LIV"))) return mk("Sony LIV", "Sony Sports Network");
    const t = /\b(?:SONY\s*)?TEN\s*([1-5])\b/.exec(u)?.[1];
    if (t) return mk(`Sony Sports Ten ${t}`, "Sony Sports Network");
    if (has("SONY")) return mk(has("SIX") ? "Sony Sports Ten 5" : "Sony Sports HD", "Sony Sports Network");
    if (/\bTEN\s+SPORTS?\b/.test(u)) return mk("Ten Sports HD", "Ten Sports");
  }
  if (has("SKY")) {
    if (has("ITALIA") || /\bIT\b/.test(u)) return mk("Sky Sport Italia", "Sky Sports");
    for (const [k, label] of skySubs) if (has(k)) return mk(`Sky Sports ${label}`, "Sky Sports");
    if (/\bSKY\s*SPORTS?\b/.test(u)) return mk("Sky Sports HD", "Sky Sports");
  }
  if (has("WILLOW")) return mk(has("EXTRA") || has("XTRA") || /\b2\b/.test(u) ? "Willow Xtra" : "Willow Cricket HD", "Willow");
  if (has("JIO") && (has("CINEMA") || has("HOTSTAR"))) return mk("JioCinema", "JioCinema");
  if (has("STAR")) {
    if (has("HINDI")) return mk("Star Sports 1 Hindi", "Star Sports");
    const sel = /\b(?:SELECT|SEL)\s*([12])\b/.exec(u)?.[1];
    if (sel) return mk(`Star Sports Select ${sel}`, "Star Sports");
    if (has("SELECT")) return mk("Star Sports Select HD", "Star Sports");
    const sn = /\b([12])\b/.exec(u)?.[1];
    if (sn) return mk(`Star Sports ${sn}`, "Star Sports");
    if (has("SPORT")) return mk("Star Sports HD", "Star Sports");
  }
  if (has("SUPERSPORT") || has("SUPER SPORT")) {
    for (const sub of SS_SUBS) if (has(sub)) return mk(`SuperSport ${sub === "PREMIER" ? "Premier League" : (sub[0] ?? "") + sub.slice(1).toLowerCase()}`, "SuperSport");
    return mk("SuperSport HD", "SuperSport");
  }
  if (has("ASTRO")) return mk(has("CRICKET") ? "Astro Cricket" : "Astro SuperSport", "Astro");
  if (has("BEIN")) { const n = /\b([1-3])\b/.exec(u)?.[1]; return mk(has("ENGLISH") ? "beIN Sports English" : n ? `beIN Sports ${n}` : "beIN Sports HD", "beIN Sports"); }
  if (has("ESPN")) return mk(has("PLUS") || has("+") ? "ESPN+" : /\b2\b/.test(u) ? "ESPN 2" : "ESPN HD", "ESPN");
  if (has("FOX CRICKET") || (has("FOX") && has("501"))) return mk("Fox Cricket 501", "Fox Sports");
  if (has("FOX SPORT") || has("KAYO")) return mk("Fox Sports HD", "Fox Sports");
  for (const [needle, re, pref, def, grp] of NUM_BROADCASTERS) if (has(needle)) { const n = re.exec(u)?.[1]; return mk(n ? `${pref}${n}${needle === "DAZN" ? " HD" : ""}` : def, grp); }
  for (const [needle, name, group] of simpleBc) if (has(needle)) return mk(name, group);
  for (const [re, name, group] of REGEX_BROADCASTERS) if (re.test(u)) return mk(name, group);
  return null;
}

function extractTargetLine(original: string): string {
  if (!original.includes("\n")) return original;
  const tagIdx = original.indexOf("🏷");
  if (tagIdx !== -1) {
    const endIdx = original.indexOf("\n", tagIdx);
    const line = (endIdx === -1 ? original.slice(tagIdx) : original.slice(tagIdx, endIdx)).trim();
    const sp = line.indexOf(" ");
    return sp > 0 && sp <= 4 ? line.slice(sp + 1).trim() : line.replace(/^🏷️?\s*/u, "");
  }
  let bestFallback = "", firstLine = "";
  for (let pos = 0; pos < original.length;) {
    const end = original.indexOf("\n", pos), next = end === -1 ? original.length : end, line = original.slice(pos, next).trim();
    pos = next + 1;
    if (!line) continue;
    firstLine ||= line;
    if (BROADCASTER_HINT_RE.test(line)) return line;
    const c0 = line.charCodeAt(0);
    if (!bestFallback && c0 < 0x2600 && c0 !== 0xD83C && c0 !== 0xD83D) bestFallback = line;
  }
  return bestFallback || firstLine;
}

export class ChannelNormalizer {
  static inferFromHostPath(host: string, lowPath: string): NormalizedChannel | null {
    for (const [needle, name, group] of ensureTables().urlRules) if (host.includes(needle) || lowPath.includes(needle)) return { name, group };
    return null;
  }

  static inferFromUrl(url?: string): NormalizedChannel | null { return url ? this.inferFromHostPath(url.toLowerCase(), "") : null; }

  static extractLanguageFromLowPath(lowPath: string): LanguageInfo {
    if (lowPath.length < 4) return ENGLISH_LANG;
    if (lowPath.length <= 160) {
      const hit = langUrlMemo.get(lowPath);
      return (hit !== undefined ? hit : memoSet(langUrlMemo, lowPath, scanLangTokens(lowPath, lowPath.length, true), MAX_MEMO)) ?? ENGLISH_LANG;
    }
    return scanLangTokens(lowPath, lowPath.length, true) ?? ENGLISH_LANG;
  }

  static extractLanguage(text: string, url?: string): LanguageInfo {
    if (text) {
      let hit = text.length <= 256 ? langTextMemo.get(text) : undefined;
      if (hit === undefined) { hit = scanLangText(text); if (text.length <= 256) memoSet(langTextMemo, text, hit, MAX_MEMO); }
      if (hit) return hit;
    }
    if (url) {
      const sIdx = url.indexOf("://"), pStart = sIdx === -1 ? 0 : url.indexOf("/", sIdx + 3), qIdx = pStart === -1 ? -1 : url.indexOf("?", pStart);
      if (pStart !== -1) {
        const pEnd = qIdx === -1 ? url.length : qIdx;
        if (pEnd - pStart >= 4) { const r = this.extractLanguageFromLowPath(pStart === 0 && pEnd === url.length ? url : url.slice(pStart, pEnd)); if (r !== ENGLISH_LANG) return r; }
      }
    }
    return ENGLISH_LANG;
  }

  static normalize(rawName?: string, rawTitle?: string, url?: string): NormalizedChannel {
    const titleStr = rawTitle ? rawTitle.trim() : "", nameStr = rawName ? rawName.trim() : "";
    let matched: NormalizedChannel | null = null;
    if (titleStr) {
      const ft = this.normalizeTextCached(titleStr);
      if (ft.group !== "General Sports" || !nameStr || ft.name !== "Standard Feed") matched = ft;
    }
    if ((!matched || matched.group === "General Sports") && nameStr && nameStr !== titleStr) {
      const fn = this.normalizeTextCached(nameStr);
      if (fn.group !== "General Sports" || !matched || matched.name === "Standard Feed") matched = fn;
    }
    const resolved = matched ?? { name: "Standard Feed", group: "General Sports" };
    return resolved.group !== "General Sports" ? resolved : this.inferFromUrl(url) ?? resolved;
  }

  private static normalizeTextCached(original: string): NormalizedChannel {
    let matched = original.length <= 256 ? channelMemo.get(original) : undefined;
    if (!matched) {
      const targetLine = extractTargetLine(original);
      matched = targetLine !== original && targetLine.length <= 256 ? channelMemo.get(targetLine) : undefined;
      if (!matched) {
        const keyBase = targetLine.includes("bps") ? targetLine.replace(BITRATE_STRIP_RE, "") : targetLine;
        matched = (keyBase !== targetLine && keyBase.length <= 256 ? channelMemo.get(keyBase) : undefined) ?? this.normalizeLine(keyBase);
        if (keyBase.length <= 256) memoSet(channelMemo, keyBase, matched, MAX_MEMO);
      }
      if (original !== targetLine && original.length <= 256) memoSet(channelMemo, original, matched, MAX_MEMO);
    }
    return matched;
  }

  private static normalizeLine(targetLine: string): NormalizedChannel {
    if (targetLine && !FAST_BROADCASTER_DIRTY_RE.test(targetLine)) { const d = matchBroadcaster(targetLine.toUpperCase()); if (d) return d; }
    let input = targetLine.replace(/https?:\/\/\S+/gi, "").replace(EMOJI_RE, " ").replace(SPAM_TRAILER_RE, " ")
      .replace(PROVIDER_NOISE_RE, " ").replace(/\[\s*\]|\(\s*\)|[•·|~:[\]]+|\s+-\s+/g, " ").replace(/\s+/g, " ").trim();
    if (GENERIC_SERVER_RE.test(input)) return { name: "Standard Feed", group: "General Sports" };
    input = input.replace(TECH_TOKEN_RE, " ").replace(/\s+/g, " ").trim();
    if (GENERIC_SERVER_RE.test(input)) return { name: "Standard Feed", group: "General Sports" };
    const known = matchBroadcaster(input.toUpperCase());
    if (known) return known;
    let generic = input.replace(/\b(?:direct|stream|server\s*\d+|feed\s*\d+|bridge)\b/gi, "").replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim();
    if (generic.length < 3) return { name: "Standard Feed", group: "General Sports" };
    generic = generic.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return BARE_LANGUAGES.has(generic.toLowerCase()) ? { name: `Live Broadcast (${generic})`, group: "General Sports" } : { name: generic, group: "General Sports" };
  }
}
