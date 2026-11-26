/**
 * Pure domain match identity & conflict engine.
 * Separates hard match discriminators (gender, age, squad, doubles, session, stage, matchNumber)
 * from soft cricket format labels so event IDs stay stable under provider format churn.
 */

export interface EventIdentity {
  format: string | null;
  session: string | null;
  matchNumber: string | null;
  stage: string | null;
  gender: "men" | "women" | null;
  ageGroup: string | null;
  squad: string | null;
  isDoubles: boolean;
  is24x7Channel: boolean;
  canonicalDiscriminator: string;
}

const F_WOMEN = 1, F_MEN = 2, F_AGE = 4, F_RESERVE = 8, F_ATEAM = 16, F_CHAN = 32;
const F_STAGE = 64, F_MNUM = 128, F_CRIC = 256, F_MOTO = 512, F_COMB = 1024, F_DBL = 2048;

const TOKEN_GROUPS = [
  "women|womens|wbbl|wpl|wnba|wta|femenino|feminin|frauen|w",
  "men|mens",
  "u|under|u17|u19|u20|u21|u23",
  "reserve|reserves|2nd|second|castilla|ii|b",
  "a|lions",
  "24|24x7|red|redzone|tv|channel",
  "final|finals|semi|semifinal|semifinals|quarter|quarterfinal|quarterfinals|sf|sf1|sf2|qf|qf1|qf2|qf3|qf4|preliminary|qualifier|eliminator|3rd|third|bronze|play|playoff|playoffs|group|round",
  "match|game|leg|test|odi|t20|t20i|t10|1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|1|2|3|4|5",
  "cricket|t10|ten|10|hundred|100|t20|t20i|twenty|20|ipl|psl|bbl|wbbl|wpl|cpl|npl|bpl|smat|sa20|ilt20|mlc|odi|one|50|test|wtc|ashes|ranji|sheffield|county|first",
  "f1|formula|motogp|moto|fp1|fp2|fp3|practice|sprint|qualifying|q1|q2|q3|pole|race",
  "early|prelim|prelims|preliminary|undercard|main|ppv",
  "doubles",
] as const;

const alnumIdx = (c: number) => (c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : -1);

let tokenFlagsMap: Map<string, number> | null = null;
let twoCharTable: Uint8Array | null = null;

function ensureTokenTables(): { flags: Map<string, number>; twoChar: Uint8Array } {
  if (tokenFlagsMap && twoCharTable) return { flags: tokenFlagsMap, twoChar: twoCharTable };
  const flags = new Map<string, number>(), twoChar = new Uint8Array(1296);
  for (let idx = 0; idx < TOKEN_GROUPS.length; idx++) {
    const bit = 1 << idx, words = TOKEN_GROUPS[idx];
    if (!words) continue;
    for (const w of words.split("|")) {
      flags.set(w, (flags.get(w) ?? 0) | bit);
      if (w.length >= 2) {
        const a = alnumIdx(w.charCodeAt(0)), b = alnumIdx(w.charCodeAt(1));
        if (a >= 0 && b >= 0) twoChar[a * 36 + b] = 1;
      }
    }
  }
  tokenFlagsMap = flags;
  twoCharTable = twoChar;
  return { flags, twoChar };
}

const WOMEN_RE = /\b(?:women'?s?|womens|wbbl|wpl|wnba|wta|femenino|f[eé]minin|frauen)\b|\b[a-z]{2,4}-w\b/;
const MEN_RE = /\b(?:men'?s?|mens)\b/;
const AGE_RE = /\b(?:u|under)[\s-]*(17|19|20|21|23)\b/;
const RESERVE_RE = /\b(?:reserves?|2nd\s*xi|second\s*xi|castilla|ii|(?:barca|barcelona|madrid)\s+b)\b/;
const A_TEAM_RE = /\b(?:india|australia|england|pakistan|south\s*africa|new\s*zealand|sri\s*lanka|bangladesh|west\s*indies|afghanistan|zimbabwe|ireland|scotland|netherlands|nepal|ind|aus|eng|pak|nz|sa|sl|ban|wi|afg)[\s-]+a\b|\bengland\s+lions\b/;
const CHANNEL_24X7_RE = /\b(?:24\/7|24x7|red\s*zone|24\s*hours?|tv\s*channel)\b/;
const MOTOR_HINT_RE = /\b(?:f1|formula\s*1|motogp|moto\s*gp)\b/;
const CRICKET_HINT_RE = /\b(?:cricket|t20i?|t10|odi|test|ipl|bbl|wbbl|wpl|psl|wtc)\b/;
const CRICKET_FMT_RE = /\b(?:(t10|ten\s*10|10\s*overs?)|(the\s*hundred|100\s*balls?)|(t20i?|twenty\s*20|20\s*overs?|ipl|psl|bbl|wbbl|wpl|cpl|npl|bpl|smat|sa20|ilt20|mlc)|(odi|one[\s-]*day|50\s*overs?)|(test|wtc|ashes|ranji|sheffield\s*shield|county\s*championship|first[\s-]*class))\b/g;
const MOTOR_SESS_RE = /\b(?:(fp1|practice\s*1)|(fp2|practice\s*2)|(fp3|practice\s*3)|(sprint\s*(?:shootout|qualifying))|(sprint)|(qualifying|q[123]|pole\s*position)|(main\s*race|race\s*day|race))\b/g;
const COMBAT_SESS_RE = /\b(?:(early\s*prelims?)|(prelims?|preliminary\s*card|undercard)|(main\s*card|main\s*event|ppv\s*card))\b/;
const STAGE_RE = /\b(?:(semi[\s-]*finals?|sf\s*[12])|(quarter[\s-]*finals?|qf\s*[1-4])|(preliminary|qualifier\s*[12])|(eliminator)|(3rd\s*place|third\s*place|bronze\s*match)|(final(?!\s*(?:four|eight)))|(play[\s-]*offs?)|(group\s*stage|round\s*of\s*(?:16|32)))\b/g;
const MATCH_NUM_EXPLICIT_RE = /\b(?:match|game|leg|test|odi|t20i?)\s*#?(\d{1,3})\b/;
const MATCH_NUM_ORD_RE = /\b(?:(1st|first)|(2nd|second)|(3rd|third)|(4th|fourth)|(5th|fifth))\b(?!\s*-?\s*(?:place|xi|class))|\b([1-5])\s*(?:test|odi|t20i?|t10|leg|match|game)\b/;

const CRICKET_LABELS = "t10|the_hundred|t20|odi|test".split("|");
const MOTOR_LABELS = "fp1|fp2|fp3|sprint_shootout|sprint|qualifying|race".split("|");
const STAGE_LABELS = "semi_final|quarter_final|qualifier|eliminator|third_place|final|playoff|group_stage".split("|");
const EMPTY_IDENTITY: EventIdentity = Object.freeze({
  format: null, session: null, matchNumber: null, stage: null, gender: null, ageGroup: null, squad: null, isDoubles: false, is24x7Channel: false, canonicalDiscriminator: "",
});

const MAX_MEMO = 4096;
const identityBySport = new Map<string, Map<string, EventIdentity>>();

function scanIdentityFlags(low: string): number {
  const { flags: tokenMap, twoChar } = ensureTokenTables();
  let flags = 0;
  for (let i = 0, start = -1, len = low.length; i <= len; i++) {
    const c = i < len ? low.charCodeAt(i) : 0;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { if (start === -1) start = i; }
    else if (c === 233) { flags |= F_WOMEN; start = -1; }
    else if (start !== -1) {
      const tLen = i - start;
      if (tLen === 1) {
        const c0 = low.charCodeAt(start);
        flags |= c0 === 97 ? F_ATEAM : c0 === 98 ? F_RESERVE : c0 === 117 ? F_AGE : c0 === 119 ? F_WOMEN : c0 >= 49 && c0 <= 53 ? F_MNUM : 0;
      } else if (tLen <= 13) {
        const a = alnumIdx(low.charCodeAt(start)), b = alnumIdx(low.charCodeAt(start + 1));
        if (a >= 0 && b >= 0 && twoChar[a * 36 + b]) flags |= tokenMap.get(low.slice(start, i)) ?? 0;
      }
      start = -1;
    }
  }
  return flags;
}

function pickBest(re: RegExp, low: string, labels: ReadonlyArray<string>): string | null {
  re.lastIndex = 0;
  let prio = 99, best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(low)) !== null) {
    for (let i = 1; i <= labels.length; i++) {
      if (m[i]) { if (i - 1 < prio) { prio = i - 1; best = labels[i - 1] ?? null; } break; }
    }
    if (prio === 0) break;
  }
  return best;
}

function parseMatchNumber(low: string): string | null {
  const exp = MATCH_NUM_EXPLICIT_RE.exec(low);
  if (exp?.[1]) return `m${exp[1]}`;
  const ord = MATCH_NUM_ORD_RE.exec(low);
  if (!ord) return null;
  for (let i = 1; i <= 5; i++) if (ord[i]) return `m${i}`;
  return ord[6] ? `m${ord[6]}` : null;
}

function buildDiscriminator(id: Pick<EventIdentity, "gender" | "ageGroup" | "squad" | "isDoubles" | "session" | "stage" | "matchNumber" | "format">, omitCricketFormat: boolean): string {
  const parts: string[] = [];
  if (id.gender === "women") parts.push("w");
  if (id.ageGroup) parts.push(id.ageGroup);
  if (id.squad) parts.push(id.squad);
  if (id.isDoubles) parts.push("dbl");
  if (id.format && !omitCricketFormat) parts.push(id.format);
  if (id.session && (omitCricketFormat || id.session !== id.format)) parts.push(id.session);
  if (id.stage) parts.push(id.stage);
  else if (id.matchNumber) parts.push(id.matchNumber);
  return parts.join("::");
}

export const buildStableDiscriminator = (id: Pick<EventIdentity, "gender" | "ageGroup" | "squad" | "isDoubles" | "session" | "stage" | "matchNumber" | "format">, sport: string): string =>
  buildDiscriminator(id, sport === "cricket");

export class EventIdentityEngine {
  static parse(text: string, sportCategory?: string): EventIdentity {
    const canMemo = text.length <= 256, spKey = sportCategory ?? "";
    let byText = canMemo ? identityBySport.get(spKey) : undefined;
    if (byText) { const hit = byText.get(text); if (hit) return hit; }

    const low = text.toLowerCase(), flags = scanIdentityFlags(low);
    let result: EventIdentity;
    if (!flags && (sportCategory !== "tennis" || !low.includes(" / "))) {
      result = EMPTY_IDENTITY;
    } else {
      const gender: "men" | "women" | null = (flags & F_WOMEN) && WOMEN_RE.test(low) ? "women" : (flags & F_MEN) && MEN_RE.test(low) ? "men" : null;
      const ageMatch = (flags & F_AGE) ? AGE_RE.exec(low) : null;
      const ageGroup = ageMatch?.[1] ? `u${ageMatch[1]}` : null;
      const squad = (flags & F_RESERVE) && RESERVE_RE.test(low) ? "reserves" : (flags & F_ATEAM) && A_TEAM_RE.test(low) ? "a_team" : null;
      const is24x7Channel = Boolean((flags & F_CHAN) && CHANNEL_24X7_RE.test(low));
      const isDoubles = sportCategory === "tennis" && ((flags & F_DBL) !== 0 || low.includes(" / "));

      let format: string | null = null, session: string | null = null;
      if (sportCategory === "motorsport" || (!sportCategory && (flags & F_MOTO) && MOTOR_HINT_RE.test(low))) {
        if (flags & F_MOTO) { session = pickBest(MOTOR_SESS_RE, low, MOTOR_LABELS); format = session; }
      } else if (sportCategory === "combat") {
        if (flags & F_COMB) { const cm = COMBAT_SESS_RE.exec(low); if (cm) session = cm[1] ? "early_prelims" : cm[2] ? "prelims" : "main_card"; }
      } else if (sportCategory === "cricket" || (!sportCategory && (flags & F_CRIC) && CRICKET_HINT_RE.test(low))) {
        if (flags & F_CRIC) format = pickBest(CRICKET_FMT_RE, low, CRICKET_LABELS);
      }

      const stage = (flags & F_STAGE) ? pickBest(STAGE_RE, low, STAGE_LABELS) : null;
      const matchNumber = (flags & F_MNUM) ? parseMatchNumber(low) : null;
      const base = { format, session, matchNumber, stage, gender, ageGroup, squad, isDoubles, is24x7Channel };
      result = { ...base, canonicalDiscriminator: buildDiscriminator(base, false) };
    }
    if (canMemo) {
      if (!byText) identityBySport.set(spKey, (byText = new Map()));
      else if (byText.size >= MAX_MEMO) byText.clear();
      byText.set(text, result);
    }
    return result;
  }

  static checkConflict(
    a: EventIdentity, b: EventIdentity
  ): null | "CONFLICTING_FORMAT" | "CONFLICTING_SESSION" | "CONFLICTING_MATCH_NUMBER" | "CONFLICTING_STAGE" | "CONFLICTING_AGE_GROUP" | "CONFLICTING_GENDER" | "CONFLICTING_SQUAD" {
    if ((a.gender === "women") !== (b.gender === "women") || (a.gender && b.gender && a.gender !== b.gender)) return "CONFLICTING_GENDER";
    if (Boolean(a.ageGroup) !== Boolean(b.ageGroup) || (a.ageGroup && b.ageGroup && a.ageGroup !== b.ageGroup)) return "CONFLICTING_AGE_GROUP";
    if (Boolean(a.squad) !== Boolean(b.squad) || (a.squad && b.squad && a.squad !== b.squad)) return "CONFLICTING_SQUAD";
    if (a.isDoubles !== b.isDoubles || (a.format && b.format && a.format !== b.format)) return "CONFLICTING_FORMAT";
    if (a.session && b.session && a.session !== b.session) return "CONFLICTING_SESSION";
    if (a.matchNumber && b.matchNumber && a.matchNumber !== b.matchNumber) return "CONFLICTING_MATCH_NUMBER";
    if (a.stage && b.stage && a.stage !== b.stage) return "CONFLICTING_STAGE";
    return null;
  }

  static areCompatible(a: EventIdentity, b: EventIdentity): boolean {
    return this.checkConflict(a, b) === null;
  }
}
