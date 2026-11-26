import { PROVIDERS, SPORT_LABELS } from "../data/taxonomy";
import type {
  BroadcasterFacetItem, CollectionMeta, CompetitionFacetItem, EventDebugInfo, EventKind,
  EventSummary, EventsQuery, FacetsPayload, FullReconciliationReport, MergeDecisionRecord, MergeResolutionType,
  PreventedMergeRecord, ProviderExtractionAccounting, ReconciliationSummary, SportFacetItem,
  TeamFacetItem, UpstreamMeta,
} from "../types";
import { ChannelNormalizer } from "./channel";
import { decodeCncPayloadData } from "./cnc";
import { EventIdentityEngine } from "./identity";
import {
  areClubsCompatible, areParticipantsCompatible, cascadeEvent, classifySport, cleanText, cleanTitle, cmp,
  computeCanonicalKey, dayBucketFromMs, extractClubIndexKeys, extractParticipantSurname,
  extractPosterParams, getSportLabel, hasCricketOverride, memoSet, normalizeSportFilter, normalizeTeamWithSlug,
  normalizeTournamentName, parseDateTimeMs, parseTeamsFromTitle, slugify, type NormalizedCandidateInput,
} from "./normalizer";

const NEAR_TIME_MS = 4 * 3_600_000, SAME_KICKOFF_FMT_MS = 3_600_000, CLUB_FUZZY_MS = 2 * 3_600_000;
const INDIV_SPORT_MS = 6 * 3_600_000, MAX_CONFLICT_MS = 48 * 3_600_000;

const QUALITY_HINT_RE = /\b(4k|2160p|1440p|1080p|720p|480p|uhd|fhd|hd|sd)\b/i;
const GENERIC_FMT_COMP_RE = /^(?:t20i?|odi|t10|test|cricket|one\s*day\s*international|t20\s*international|international)$/i;
const INDIV_SPORTS = new Set("tennis|combat|table_tennis|badminton|snooker|darts".split("|"));
const EMPTY_STR: string[] = [];
const EXACT_SIGS = ["exact_canonical_key"];
const bcGroupCache = new Map<string, string>();
const fmtHintCache = new Map<string, { bc: string | null; bcArr: string[]; lc: string; lcArr: string[]; qh: string | null }>();
const MERGE_CONF: Record<MergeResolutionType, number> = {
  exact_key: 1, cross_format: 0.94, near_time: 0.92, cross_sport_rescue: 0.92, participant_surname: 0.91, club_fuzzy: 0.91, nodate_attach: 0.88,
};

export interface IndexedEventRecord {
  index: number; idHash: number; statusRank: 0 | 1 | 2; event: EventSummary; eventJson?: string; debug: EventDebugInfo;
  startMs: number | null; endMs: number | null; searchText: string | null;
  providers: string[]; broadcasterSlugs: string[]; languages: string[];
}

export interface CatalogSnapshot {
  generatedAt: string; fetchedAtMs: number; stale: boolean; degraded: boolean; healthyProviders: number;
  events: EventSummary[]; records: IndexedEventRecord[]; allIndices: number[];
  byId: Map<string, IndexedEventRecord>;
  byStatus: { live: number[]; upcoming: number[]; ended: number[]; active: number[] };
  bySport: Map<string, number[]>; byCompetition: Map<string, number[]>;
  byTeam: Map<string, number[]>; byBroadcaster: Map<string, number[]>;
  facets: FacetsPayload; facetsBySport?: Map<string, FacetsPayload>; reconciliation: FullReconciliationReport;
}

interface SerializedSnapshot {
  v: 3; generatedAt: string; fetchedAtMs: number; healthyProviders: number;
  entries: Array<{ event: EventSummary; debug: EventDebugInfo; startMs: number | null; endMs: number | null }>;
  reconciliation: FullReconciliationReport;
}

interface ReconBucket {
  canonicalKey: string; sport: string; kind: EventKind; pairSlug: string | null; titleSlug: string;
  dateBucket: string; startMs: number | null; teams: [string, string] | null; teamSlugs: [string, string] | null;
  identity: NormalizedCandidateInput["identity"]; resolvedFormat: string | null;
  items: NormalizedCandidateInput[]; mergeType: MergeResolutionType; signals: string[] | null; reversedHomeAway: boolean;
}

export interface ProviderCatalogResult {
  provider: string; name: string; items: UpstreamMeta[]; rawCount: number;
  exclusions: ProviderExtractionAccounting["exclusions"]; healthy: boolean;
}

const parseBool = (v: unknown): boolean => Boolean(v && (v === true || typeof v === "number" || (typeof v === "string" && /^(?:true|1|yes)$/i.test(v.trim()))));
const parseUrlIfHttp = (v: unknown): string | null => {
  if (!v || typeof v !== "string" || v.length < 8) return null;
  const s = v.charCodeAt(0) <= 32 || v.charCodeAt(v.length - 1) <= 32 ? v.trim() : v;
  return s.charCodeAt(0) === 104 && (s.startsWith("https://") || s.startsWith("http://")) ? s : null;
};

function getFmtHint(fmt: unknown) {
  const isStr = typeof fmt === "string", o = isStr ? null : (fmt as { title?: string; webLink?: string } | null);
  const fTitle = isStr ? fmt : o?.title ?? "", fUrl = isStr ? undefined : o?.webLink ?? undefined;
  if (!fTitle && !fUrl) return null;
  const canMemo = !fUrl && fTitle.length <= 128;
  if (canMemo) { const hit = fmtHintCache.get(fTitle); if (hit) return hit; }
  const ch = ChannelNormalizer.normalize(fTitle, undefined, fUrl), lc = ChannelNormalizer.extractLanguage(fTitle, fUrl).code;
  const m = fTitle ? QUALITY_HINT_RE.exec(fTitle)?.[1]?.toLowerCase() : undefined;
  const qh = !m ? null : m === "4k" || m === "2160p" || m === "uhd" ? "4K" : m === "1440p" ? "1440p" : m === "1080p" || m === "fhd" ? "1080p" : m === "720p" || m === "hd" ? "720p" : "480p";
  const bc = ch.name && ch.name !== "Standard Feed" ? ch.name : null;
  const res = { bc, bcArr: bc ? [bc] : EMPTY_STR, lc, lcArr: [lc], qh };
  return canMemo ? memoSet(fmtHintCache, fTitle, res, 1024) : res;
}

const getBcGroup = (name: string): string => bcGroupCache.get(name) ?? memoSet(bcGroupCache, name, ChannelNormalizer.normalize(name, name).group, 512);
const pushMap = <K>(m: Map<K, number[]>, k: K, idx: number): void => { const a = m.get(k); if (a) a.push(idx); else m.set(k, [idx]); };
const addIdx = <K>(m: Map<K, number | number[]>, k: K, idx: number): void => {
  const v = m.get(k);
  if (v === undefined) m.set(k, idx); else if (typeof v === "number") m.set(k, [v, idx]); else v.push(idx);
};

function resolvePhysicsFormat(items: ReadonlyArray<NormalizedCandidateInput>): string {
  const scores = new Map<string, number>(), rank: Record<string, number> = { test: 5, odi: 4, t20: 3, the_hundred: 2, t10: 1 };
  for (const it of items) {
    const f = it.identity.format;
    if (!f) continue;
    let w = it.tournament && !GENERIC_FMT_COMP_RE.test(it.tournament) ? 1.5 : 1;
    if (it.startMs !== null && it.endMs !== null && it.endMs > it.startMs) {
      const mins = (it.endMs - it.startMs) / 60_000;
      if ((f === "t20" && mins <= 300) || (f === "odi" && mins >= 360 && mins <= 660) || (f === "test" && mins > 1440)) w += 0.3;
    }
    scores.set(f, (scores.get(f) ?? 0) + w);
  }
  let best = "t20", bestScore = -1;
  for (const [f, s] of scores) if (s > bestScore || (s === bestScore && (rank[f] ?? 0) > (rank[best] ?? 0))) { bestScore = s; best = f; }
  return best;
}

export function extractCandidate(provider: string, meta: UpstreamMeta, sourceIndex?: number): NormalizedCandidateInput {
  const data = decodeCncPayloadData(meta.id), info = data?.eventInfo, pRaw = data?.poster ?? meta.poster;
  const pp = typeof pRaw === "string" && pRaw.includes("?") && (!info?.teamA || !info.teamB || !info.startTime || !info.eventName || !info.teamAFlag || !info.teamBFlag || !info.eventLogo || pRaw.includes("isEnded=true")) ? extractPosterParams(pRaw) : null;

  const rawTitle = cleanTitle(data?.title ?? meta.name ?? pp?.title ?? info?.eventName ?? "");
  const rawTourney = cleanText(info?.eventName ?? info?.eventType ?? pp?.tournament ?? "");
  let rA = info?.teamA ? info.teamA.trim() : pp?.teamA ?? "", rB = info?.teamB ? info.teamB.trim() : pp?.teamB ?? "";
  if (!rA || !rB) { const p = parseTeamsFromTitle(rawTitle, true); if (p) [rA, rB] = p; }
  const rawTeams: [string, string] | null = rA && rB && (rA.length !== rB.length || rA.toLowerCase() !== rB.toLowerCase()) ? [rA, rB] : null;

  const spSrc = info?.eventCat ?? data?.cat ?? data?.category ?? pp?.sport ?? "";
  let sport = normalizeSportFilter(spSrc);
  if (!sport || (sport === "cricket" && (hasCricketOverride(rawTourney) || hasCricketOverride(rawTitle) || (info?.eventType !== rawTourney && hasCricketOverride(info?.eventType))))) {
    const rs = spSrc ? cleanText(spSrc) : "", low = rs.toLowerCase();
    const eff = rs && low !== "tv" && low !== "live" && low !== "other" && low !== "all" ? rs : cleanText(data?.cat ?? data?.category ?? info?.eventType ?? "");
    sport = classifySport(eff, SPORT_LABELS[low] && low !== "cricket" ? rawTourney : info?.eventType ? `${rawTourney} ${info.eventType}` : rawTourney, rawTitle, rawTeams, provider);
  }

  let idText = rawTourney ? `${rawTitle} ${rawTourney}` : rawTitle;
  if (info?.eventType && info.eventType !== rawTourney) idText += ` ${info.eventType}`;
  if (rA && !rawTitle.includes(rA)) idText += ` ${rA}`;
  if (rB && !rawTitle.includes(rB)) idText += ` ${rB}`;
  const identity = EventIdentityEngine.parse(idText, sport);

  let teams: [string, string] | null = null, teamSlugs: [string, string] | null = null;
  if (rawTeams) {
    const nA = normalizeTeamWithSlug(rawTeams[0], sport), nB = normalizeTeamWithSlug(rawTeams[1], sport);
    if (nA.slug && nB.slug && nA.slug !== nB.slug) { teams = [nA.name, nB.name]; teamSlugs = [nA.slug, nB.slug]; }
  }

  const tournament = normalizeTournamentName(rawTourney || info?.eventType || "", sport, rawTitle, Boolean(rawTourney));
  const startMs = parseDateTimeMs(info?.startTime ?? pp?.startTimeRaw ?? null), endMs = parseDateTimeMs(info?.endTime ?? null);

  let broadcasters = EMPTY_STR, languages = EMPTY_STR, streamHintCount = 0, maxQualityHint: string | null = null;
  const fmts = data?.formats;
  if (Array.isArray(fmts) && fmts.length) {
    streamHintCount = fmts.length;
    if (fmts.length === 1) { const h = getFmtHint(fmts[0]); if (h) { broadcasters = h.bcArr; languages = h.lcArr; maxQualityHint = h.qh; } }
    else {
      broadcasters = []; languages = [];
      for (const f of fmts) {
        const h = getFmtHint(f);
        if (!h) continue;
        if (h.bc && !broadcasters.includes(h.bc)) broadcasters.push(h.bc);
        if (!languages.includes(h.lc)) languages.push(h.lc);
        if (h.qh && (!maxQualityHint || h.qh === "4K" || (h.qh === "1080p" && maxQualityHint !== "4K"))) maxQualityHint = h.qh;
      }
    }
  }

  const { key: canonicalKey, kind, pairSlug, dateBucket } = computeCanonicalKey(sport, teams, identity, tournament, rawTitle || tournament, startMs, teamSlugs);
  return {
    provider, sourceIndex, rawId: meta.id, title: rawTitle || (teams ? `${teams[0]} vs ${teams[1]}` : tournament),
    tournament, sport, kind, teams, teamSlugs, rawTeams,
    teamALogo: parseUrlIfHttp(info?.teamAFlag) ?? pp?.teamALogo ?? null, teamBLogo: parseUrlIfHttp(info?.teamBFlag) ?? pp?.teamBLogo ?? null,
    competitionLogo: parseUrlIfHttp(info?.eventLogo) ?? pp?.competitionLogo ?? null,
    poster: parseUrlIfHttp(meta.poster) ?? parseUrlIfHttp(data?.poster) ?? null, banner: parseUrlIfHttp(info?.eventBanner) ?? parseUrlIfHttp(meta.background) ?? null,
    startMs, endMs, isLiveFlag: parseBool(info?.isLive) || Boolean(pp?.isLive), isEndedFlag: parseBool(info?.isEnded) || Boolean(pp?.isEnded),
    isHot: parseBool(info?.isHot) || parseBool(info?.isPinned), identity, broadcasters, languages, maxQualityHint, streamHintCount, canonicalKey, pairSlug, dateBucket,
  };
}

function mergeBuckets(t: ReconBucket, s: ReconBucket, mergeType: MergeResolutionType, sig: string, rev: boolean): void {
  for (const it of s.items) t.items.push(it);
  if (t.startMs === null && s.startMs !== null) { t.startMs = s.startMs; t.dateBucket = s.dateBucket; }
  if (t.sport === "other" && s.sport !== "other") t.sport = s.sport;
  if (s.teams && (!t.teams || teamNameLen(s) > teamNameLen(t))) { t.teams = s.teams; t.teamSlugs = s.teamSlugs; }
  const id = t.identity, si = s.identity;
  if ((!id.format && si.format) || (!id.session && si.session) || (!id.matchNumber && si.matchNumber) || (!id.stage && si.stage)) {
    t.identity = { ...id, format: id.format ?? si.format, session: id.session ?? si.session, matchNumber: id.matchNumber ?? si.matchNumber, stage: id.stage ?? si.stage };
  }
  if (t.mergeType === "exact_key") t.mergeType = mergeType;
  (t.signals ??= ["exact_canonical_key"]).push(sig);
  if (rev) t.reversedHomeAway = true;
}

const sortByAct = <T extends { live: number; total: number; id: string }>(arr: T[]): T[] =>
  arr.sort((a, b) => b.live - a.live || b.total - a.total || cmp(a.id, b.id));

function buildFacetsFromRecords(records: ReadonlyArray<IndexedEventRecord>, fixedSport?: string | null): FacetsPayload {
  let live = 0, upcoming = 0, ended = 0;
  const sM = new Map<string, SportFacetItem>(), cM = new Map<string, CompetitionFacetItem>();
  const tM = new Map<string, TeamFacetItem>(), bM = new Map<string, BroadcasterFacetItem>();
  const bump = <T extends { live: number; upcoming: number; total: number; ended?: number }>(m: Map<string, T>, k: string, init: () => T, isL: boolean, isU: boolean): T => {
    let o = m.get(k);
    if (!o) m.set(k, (o = init()));
    o.total++;
    if (isL) o.live++; else if (isU) o.upcoming++; else if (o.ended !== undefined) o.ended++;
    return o;
  };
  for (const r of records) {
    const e = r.event, isL = r.statusRank === 0, isU = r.statusRank === 1;
    if (isL) live++; else if (isU) upcoming++; else ended++;
    if (!fixedSport) bump(sM, e.sport, () => ({ id: e.sport, label: getSportLabel(e.sport), live: 0, upcoming: 0, ended: 0, total: 0 }), isL, isU);
    bump(cM, fixedSport ? e.competition.id : `${e.sport}::${e.competition.id}`, () => ({ id: e.competition.id, name: e.competition.name, sport: e.sport, logo: e.competition.logo, live: 0, upcoming: 0, total: 0 }), isL, isU);
    if (e.teams) for (const tm of [e.teams.home, e.teams.away]) bump(tM, fixedSport ? tm.id : `${e.sport}::${tm.id}`, () => ({ id: tm.id, name: tm.name, code: tm.code, sport: e.sport, logo: tm.logo, live: 0, upcoming: 0, total: 0 }), isL, isU);
    for (let b = 0; b < e.broadcasters.length; b++) {
      const bn = e.broadcasters[b], bi = r.broadcasterSlugs[b];
      if (!bn || !bi) continue;
      const bf = bump(bM, bi, () => ({ id: bi, name: bn, group: getBcGroup(bn), live: 0, upcoming: 0, total: 0, sports: [] }), isL, isU);
      if (!bf.sports.includes(e.sport)) bf.sports.push(e.sport);
    }
  }
  const broadcasters = sortByAct([...bM.values()]);
  for (const b of broadcasters) if (b.sports.length > 1) b.sports.sort(cmp);
  return {
    counts: { live, upcoming, ended, active: live + upcoming },
    sports: fixedSport ? (records.length ? [{ id: fixedSport, label: getSportLabel(fixedSport), live, upcoming, ended, total: records.length }] : []) : sortByAct([...sM.values()]),
    competitions: sortByAct([...cM.values()]), teams: sortByAct([...tM.values()]), broadcasters,
  };
}

function hashStr32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const getSearchText = (r: IndexedEventRecord): string =>
  (r.searchText ??= `${r.event.title} ${r.event.competition.name} ${r.event.sport} ${getSportLabel(r.event.sport)} ${r.event.teams ? `${r.event.teams.home.code} ${r.event.teams.away.code}` : ""} ${r.event.broadcasters.join(" ")}`.toLowerCase());

const buildIndexedRecord = (index: number, event: EventSummary, debug: EventDebugInfo, startMs: number | null, endMs: number | null, provs?: string[]): IndexedEventRecord => ({
  index, idHash: hashStr32(event.id), statusRank: event.status === "live" ? 0 : event.status === "upcoming" ? 1 : 2,
  event, debug, startMs, endMs, searchText: null, providers: provs ?? Object.keys(debug.providerRawIds),
  broadcasterSlugs: event.broadcasters.length ? event.broadcasters.map(slugify).filter(Boolean) : EMPTY_STR, languages: event.languages,
});

function indexSnapshotRecords(
  records: IndexedEventRecord[], generatedAt: string, fetchedAtMs: number,
  healthyProviders: number, providersTotal: number, reconciliation: FullReconciliationReport, stale = false
): CatalogSnapshot {
  const n = records.length, events: EventSummary[] = new Array(n), allIndices: number[] = new Array(n);
  const byId = new Map<string, IndexedEventRecord>(), bySport = new Map<string, number[]>(), byCompetition = new Map<string, number[]>();
  const byTeam = new Map<string, number[]>(), byBroadcaster = new Map<string, number[]>();
  const byStatus = { live: [] as number[], upcoming: [] as number[], ended: [] as number[], active: [] as number[] };
  for (let i = 0; i < n; i++) {
    const r = records[i];
    if (!r) continue;
    const e = r.event;
    r.index = i; events[i] = e; allIndices[i] = i; byId.set(e.id, r);
    if (r.statusRank === 0) { byStatus.live.push(i); byStatus.active.push(i); }
    else if (r.statusRank === 1) { byStatus.upcoming.push(i); byStatus.active.push(i); }
    else byStatus.ended.push(i);
    pushMap(bySport, e.sport, i); pushMap(byCompetition, e.competition.id, i);
    if (e.teams) { pushMap(byTeam, e.teams.home.id, i); pushMap(byTeam, e.teams.away.id, i); }
    for (const sl of r.broadcasterSlugs) pushMap(byBroadcaster, sl, i);
  }
  let cachedFacets: FacetsPayload | null = null;
  return {
    generatedAt, fetchedAtMs, stale, degraded: healthyProviders < providersTotal, healthyProviders,
    events, records, allIndices, byId, byStatus, bySport, byCompetition, byTeam, byBroadcaster,
    get facets() { return cachedFacets ?? (cachedFacets = buildFacetsFromRecords(records)); },
    reconciliation,
  };
}

export const serializeSnapshot = (s: CatalogSnapshot): string => JSON.stringify({
  v: 3, generatedAt: s.generatedAt, fetchedAtMs: s.fetchedAtMs, healthyProviders: s.healthyProviders,
  entries: s.records.map((r) => ({ event: r.event, debug: r.debug, startMs: r.startMs, endMs: r.endMs })), reconciliation: s.reconciliation,
} satisfies SerializedSnapshot);

export function hydrateSnapshot(rawJson: string): CatalogSnapshot | null {
  try {
    const o = JSON.parse(rawJson) as Partial<SerializedSnapshot> | null;
    return !o || o.v !== 3 || !Array.isArray(o.entries) || typeof o.fetchedAtMs !== "number" || !o.reconciliation || !o.generatedAt ? null
      : indexSnapshotRecords(o.entries.map((e, i) => buildIndexedRecord(i, e.event, e.debug, e.startMs, e.endMs)), o.generatedAt, o.fetchedAtMs, o.healthyProviders ?? PROVIDERS.length, PROVIDERS.length, o.reconciliation, false);
  } catch { return null; }
}

const teamNameLen = (b: ReconBucket): number => (b.teams ? b.teams[0].length + b.teams[1].length : 0);
const sportsCompat = (a: ReconBucket, b: ReconBucket): boolean => a.sport === b.sport || a.sport === "other" || b.sport === "other";

export function buildCatalogSnapshot(providerPayloads: ReadonlyArray<ProviderCatalogResult>, nowMs: number): CatalogSnapshot {
  const generatedAt = new Date(nowMs).toISOString(), ordered = [...providerPayloads].sort((a, b) => cmp(a.provider, b.provider));
  const mappedFlags: Uint8Array[] = [], bucketMap = new Map<string, ReconBucket>();
  let healthy = 0, totalRaw = 0, totalValid = 0, totalExcl = 0;

  for (let pi = 0; pi < ordered.length; pi++) {
    const p = ordered[pi];
    if (!p) continue;
    mappedFlags.push(new Uint8Array(p.items.length));
    if (p.healthy) healthy++;
    totalRaw += p.rawCount; totalValid += p.items.length; totalExcl += p.exclusions.length;
    for (let idx = 0; idx < p.items.length; idx++) {
      const m = p.items[idx];
      if (!m) continue;
      const c = extractCandidate(p.provider, m, idx), ex = bucketMap.get(c.canonicalKey);
      c.providerIndex = pi;
      if (ex) {
        if (ex.teamSlugs && c.teamSlugs && ex.teamSlugs[0] === c.teamSlugs[1] && ex.teamSlugs[1] === c.teamSlugs[0]) {
          ex.reversedHomeAway = true;
          const sigs = (ex.signals ??= ["exact_canonical_key"]);
          if (!sigs.includes("reversed_home_away")) sigs.push("reversed_home_away");
        }
        ex.items.push(c);
        if (c.startMs !== null && (ex.startMs === null || c.startMs < ex.startMs)) { ex.startMs = c.startMs; ex.dateBucket = dayBucketFromMs(c.startMs); }
        if (c.teams && (!ex.teams || c.teams[0].length + c.teams[1].length > teamNameLen(ex))) { ex.teams = c.teams; ex.teamSlugs = c.teamSlugs; }
      } else {
        bucketMap.set(c.canonicalKey, {
          canonicalKey: c.canonicalKey, sport: c.sport, kind: c.kind, pairSlug: c.pairSlug,
          titleSlug: c.pairSlug || c.kind === "channel" ? "" : slugify(c.title),
          dateBucket: c.dateBucket, startMs: c.startMs, teams: c.teams, teamSlugs: c.teamSlugs,
          identity: c.identity, resolvedFormat: null, items: [c], mergeType: "exact_key", signals: null, reversedHomeAway: false,
        });
      }
    }
  }

  const buckets = [...bucketMap.values()].sort((a, b) => cmp(a.canonicalKey, b.canonicalKey));
  const absorbed = new Uint8Array(buckets.length), prevented: PreventedMergeRecord[] = [];
  const alive = (i?: number) => (i !== undefined && !absorbed[i] ? buckets[i] : undefined);
  const addPrev = (a: ReconBucket, b: ReconBucket, reason: PreventedMergeRecord["reason"], details = `${a.canonicalKey} vs ${b.canonicalKey}`, pair = a.pairSlug ?? "") =>
    prevented.push({ keyA: a.canonicalKey, keyB: b.canonicalKey, pair, reason, details });
  let rND = 0, rCF = 0, rNT = 0, rPS = 0, rClub = 0;

  const pairIdx = new Map<string, number | number[]>(), surIdx = new Map<string, number | number[]>(), hourIdx = new Map<number, number | number[]>(), showIdx = new Map<string, number | number[]>();
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!b) continue;
    if (b.pairSlug) {
      addIdx(pairIdx, b.pairSlug, i);
      if (INDIV_SPORTS.has(b.sport) && b.teams) {
        const s0 = extractParticipantSurname(b.teams[0]), s1 = extractParticipantSurname(b.teams[1]);
        if (s0.length >= 3 && s1.length >= 3) addIdx(surIdx, `${b.sport}::${s0 < s1 ? `${s0}|${s1}` : `${s1}|${s0}`}`, i);
      } else if (b.startMs !== null && b.kind === "match") addIdx(hourIdx, Math.floor(b.startMs / CLUB_FUZZY_MS), i);
    } else if (b.titleSlug) addIdx(showIdx, `${b.sport}::${b.titleSlug}`, i);
  }

  const splitDated = (indices: number[], byLen: boolean) => {
    const dated: number[] = [], nodate: number[] = [];
    for (const idx of indices) { const b = alive(idx); if (b) (b.startMs !== null ? dated : nodate).push(idx); }
    dated.sort((ia, ib) => {
      const a = buckets[ia], b = buckets[ib];
      return !a || !b ? 0 : ((a.startMs ?? 0) - (b.startMs ?? 0)) || (byLen ? teamNameLen(b) - teamNameLen(a) : (a.sport === "other" ? 1 : 0) - (b.sport === "other" ? 1 : 0)) || cmp(a.canonicalKey, b.canonicalKey);
    });
    return { dated, nodate };
  };
  const scanDated = (list: number[], maxD: number, onP: (i: number, a: ReconBucket, j: number, b: ReconBucket, d: number) => void) => {
    for (let x = 0; x < list.length; x++) {
      const i = list[x], a = alive(i);
      if (!a || a.startMs === null || i === undefined) continue;
      for (let y = x + 1; y < list.length; y++) {
        const j = list[y], b = alive(j);
        if (!b || b.startMs === null || j === undefined) continue;
        const d = b.startMs - a.startMs;
        if (d > maxD) break;
        onP(i, a, j, b, d);
        if (absorbed[i]) break;
      }
    }
  };

  for (const indices of pairIdx.values()) {
    if (typeof indices === "number") continue;
    const { dated, nodate } = splitDated(indices, false);
    scanDated(dated, MAX_CONFLICT_MS, (_i, a, j, o, d) => {
      if ((a.kind === "channel") !== (o.kind === "channel")) { addPrev(a, o, "CONFLICTING_KIND", `${a.kind} vs ${o.kind}`); return; }
      const rescue = a.sport !== o.sport && (a.sport === "other" || o.sport === "other");
      if (a.sport !== o.sport && !rescue) { addPrev(a, o, "INCOMPATIBLE_SPORT", `${a.sport} vs ${o.sport}`); return; }
      const rev = Boolean(a.teamSlugs && o.teamSlugs && a.teamSlugs[0] === o.teamSlugs[1]), conflict = EventIdentityEngine.checkConflict(a.identity, o.identity);
      if (conflict) {
        if (conflict === "CONFLICTING_FORMAT" && (a.sport === "cricket" || o.sport === "cricket") && !a.identity.isDoubles && !o.identity.isDoubles && !a.identity.matchNumber && !o.identity.matchNumber && !(a.identity.stage && o.identity.stage && a.identity.stage !== o.identity.stage) && d <= SAME_KICKOFF_FMT_MS) {
          mergeBuckets(a, o, "cross_format", "physics_same_kickoff_format_resolution", rev);
          a.resolvedFormat = resolvePhysicsFormat(a.items); a.identity = { ...a.identity, format: a.resolvedFormat };
          absorbed[j] = 1; rCF++; return;
        }
        addPrev(a, o, conflict); return;
      }
      if (d > NEAR_TIME_MS) { addPrev(a, o, "EXCEEDED_TIME_WINDOW", `Start delta ${Math.round(d / 60_000)}m exceeds 240m`); return; }
      const diffD = a.identity.canonicalDiscriminator !== o.identity.canonicalDiscriminator;
      mergeBuckets(a, o, rescue ? "cross_sport_rescue" : diffD ? "cross_format" : "near_time", rescue ? "rescued_unclassified_sport_match" : diffD ? "cross_format_compatible" : "sliding_proximity_within_4h", rev);
      absorbed[j] = 1; if (!rescue && diffD) rCF++; else rNT++;
    });
    for (const j of nodate) {
      const o = alive(j);
      if (!o) continue;
      let best: ReconBucket | undefined, bestD = Infinity;
      for (const idx of dated) {
        const c = alive(idx);
        if (!c || c.startMs === null || (c.kind === "channel") !== (o.kind === "channel") || !sportsCompat(c, o) || !EventIdentityEngine.areCompatible(c.identity, o.identity)) continue;
        const dist = Math.abs(c.startMs - nowMs);
        if (dist < bestD) { bestD = dist; best = c; }
      }
      if (best) { mergeBuckets(best, o, "nodate_attach", "nodate_attached_to_active_fixture", Boolean(best.teamSlugs && o.teamSlugs && best.teamSlugs[0] === o.teamSlugs[1])); absorbed[j] = 1; rND++; }
    }
  }

  for (const indices of surIdx.values()) {
    if (typeof indices === "number") continue;
    const { dated, nodate } = splitDated(indices, true);
    const tryM = (i: number, a: ReconBucket, j: number, b: ReconBucket) => {
      if (!a.teams || !b.teams || a.pairSlug === b.pairSlug) return;
      const m = areParticipantsCompatible(a.teams, b.teams, a.sport);
      if (m.conflict) { addPrev(a, b, m.conflict, `${a.teams.join(" vs ")} vs ${b.teams.join(" vs ")}`, `${a.pairSlug ?? ""} / ${b.pairSlug ?? ""}`); return; }
      if (!m.matched) return;
      const idC = EventIdentityEngine.checkConflict(a.identity, b.identity);
      if (idC) { addPrev(a, b, idC); return; }
      const keepA = teamNameLen(a) >= teamNameLen(b);
      mergeBuckets(keepA ? a : b, keepA ? b : a, "participant_surname", "individual_participant_surname_match", m.reversed);
      absorbed[keepA ? j : i] = 1; rPS++;
    };
    scanDated(dated, INDIV_SPORT_MS, (i, a, j, b) => tryM(i, a, j, b));
    for (const j of nodate) { const b = alive(j); if (b) for (const i of dated) { const a = alive(i); if (a) { tryM(i, a, j, b); if (absorbed[j]) break; } } }
  }

  const scanClub = (g: number[]) => {
    if (g.length < 2) return;
    g.sort((ia, ib) => { const a = buckets[ia], b = buckets[ib]; return !a || !b ? 0 : ((a.sport === "other" ? 1 : 0) - (b.sport === "other" ? 1 : 0)) || (teamNameLen(b) - teamNameLen(a)) || cmp(a.canonicalKey, b.canonicalKey); });
    for (let x = 0; x < g.length; x++) {
      const i = g[x], a = alive(i);
      if (!a?.teams || a.startMs === null || i === undefined) continue;
      for (let y = x + 1; y < g.length; y++) {
        const j = g[y], b = j !== i ? alive(j) : undefined;
        if (!b?.teams || b.startMs === null || j === undefined || a.pairSlug === b.pairSlug || !sportsCompat(a, b) || Math.abs(a.startMs - b.startMs) > CLUB_FUZZY_MS || EventIdentityEngine.checkConflict(a.identity, b.identity) !== null) continue;
        const cm = areClubsCompatible(a.teams, b.teams, a.teamSlugs, b.teamSlugs);
        if (cm.matched) { mergeBuckets(a, b, "club_fuzzy", "club_acronym_or_subset_within_2h", cm.reversed); absorbed[j] = 1; rClub++; }
      }
    }
  };
  const eachOf = (v: number | number[] | undefined, fn: (idx: number) => void) => { if (typeof v === "number") { if (!absorbed[v]) fn(v); } else if (v) for (const vi of v) if (!absorbed[vi]) fn(vi); };
  for (const bin of [...hourIdx.keys()].sort((a, b) => a - b)) {
    const b0 = hourIdx.get(bin), b1 = hourIdx.get(bin + 1);
    const total = (b0 === undefined ? 0 : typeof b0 === "number" ? 1 : b0.length) + (b1 === undefined ? 0 : typeof b1 === "number" ? 1 : b1.length);
    if (total < 2) continue;
    if (total <= 8) { const g: number[] = []; eachOf(b0, (i) => g.push(i)); eachOf(b1, (i) => g.push(i)); scanClub(g); continue; }
    const kG = new Map<string, number[]>();
    const addC = (idx: number) => { for (const sl of buckets[idx]?.teamSlugs ?? []) for (const k of extractClubIndexKeys(sl)) { const l = kG.get(k); if (l) { if (l[l.length - 1] !== idx) l.push(idx); } else kG.set(k, [idx]); } };
    eachOf(b0, addC); eachOf(b1, addC);
    for (const g of kG.values()) scanClub(g);
  }

  for (const indices of showIdx.values()) {
    if (typeof indices === "number") continue;
    indices.sort((a, b) => (buckets[a]?.startMs ?? 0) - (buckets[b]?.startMs ?? 0));
    scanDated(indices, NEAR_TIME_MS, (_i, a, j, b) => { if (EventIdentityEngine.checkConflict(a.identity, b.identity) === null) { mergeBuckets(a, b, "near_time", "show_sliding_window_within_4h", false); absorbed[j] = 1; rNT++; } });
  }

  const records: IndexedEventRecord[] = [], mergeDecisions: MergeDecisionRecord[] = [];
  let rRev = 0, multi = 0, confSum = 0, active = 0, ended = 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = alive(i);
    if (!b) continue;
    const conf = MERGE_CONF[b.mergeType], { event, debug, providers: provs, startMs, endMs } = cascadeEvent(b.canonicalKey, b.items, b.mergeType, conf, b.signals ?? EXACT_SIGS, nowMs, b.resolvedFormat);
    if (b.reversedHomeAway) rRev++;
    if (event.providerCount >= 2) multi++;
    if (event.status === "ended") ended++; else active++;
    confSum += conf;
    for (const it of b.items) if (it.sourceIndex !== undefined && it.providerIndex !== undefined) { const fl = mappedFlags[it.providerIndex]; if (fl) fl[it.sourceIndex] = 1; }
    if (provs.length > 1) provs.sort(cmp);
    if (b.items.length > 1) mergeDecisions.push({ eventId: event.id, canonicalKey: debug.canonicalKey, title: event.title, sport: event.sport, mergeType: debug.mergeType, confidence: debug.mergeConfidence, providers: provs, rawItemCount: b.items.length, reversedHomeAway: b.reversedHomeAway, signals: debug.mergeSignals });
    records.push(buildIndexedRecord(0, event, debug, startMs, endMs, provs));
  }

  records.sort((a, b) => (a.statusRank - b.statusRank) || (a.statusRank === 0 ? ((b.event.hot ? 1 : 0) - (a.event.hot ? 1 : 0)) || (b.event.providerCount - a.event.providerCount) : 0) || ((a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER)) || cmp(a.event.id, b.event.id));

  let unmapped = 0;
  const providerAccounting: ProviderExtractionAccounting[] = ordered.map((p, pi) => {
    const fl = mappedFlags[pi], unmappedIds: string[] = [];
    for (let idx = 0; idx < p.items.length; idx++) { const it = p.items[idx]; if (it && (!fl || !fl[idx])) unmappedIds.push(it.id); }
    unmapped += unmappedIds.length;
    return { provider: p.provider, name: p.name, rawPayloadCount: p.rawCount, validItemsCount: p.items.length, excludedItemsCount: p.exclusions.length, mappedCount: p.items.length - unmappedIds.length, unmappedIds, exclusions: p.exclusions };
  });

  const summary: ReconciliationSummary = {
    status: unmapped === 0 && healthy > 0 ? "verified_zero_loss" : "degraded_partial_loss",
    providersQueried: ordered.length, healthyProviders: healthy, rawPayloadItems: totalRaw, validItemsExtracted: totalValid,
    excludedInvalidItems: totalExcl, unifiedEvents: records.length, activeEvents: active, endedEvents: ended, multiProviderEvents: multi,
    deduplicatedMerged: Math.max(0, totalValid - records.length), reconciledCrossFormat: rCF, reconciledNearTime: rNT, reconciledNoDate: rND,
    reconciledParticipantSurname: rPS, reconciledClubFuzzy: rClub, reversedHomeAwayResolved: rRev, preventedFalseMerges: prevented.length,
    unmappedRawItemsCount: unmapped, averageConfidence: records.length ? Math.round((confSum / records.length) * 1000) / 1000 : 1,
  };
  return indexSnapshotRecords(records, generatedAt, nowMs, healthy, ordered.length, { generatedAt, summary, providerAccounting, mergeDecisions, preventedMerges: prevented }, false);
}

export function queryFacetsFromSnapshot(snap: CatalogSnapshot, opts?: { sport?: string; status?: string; q?: string }): FacetsPayload {
  const sport = normalizeSportFilter(opts?.sport) ?? (opts?.sport?.trim().toLowerCase() || null);
  const status = opts?.status?.trim().toLowerCase() || null, q = opts?.q?.trim().toLowerCase() || null;
  if (!sport && !status && !q) return snap.facets;
  if (sport && !status && !q) { const hit = snap.facetsBySport?.get(sport); if (hit) return hit; }
  const filtered: IndexedEventRecord[] = [];
  for (const i of sport ? (snap.bySport.get(sport) ?? []) : snap.allIndices) {
    const r = snap.records[i];
    if (r && (!status || status === "all" || (status === "active" ? r.statusRank !== 2 : r.event.status === status)) && (!q || getSearchText(r).includes(q))) filtered.push(r);
  }
  const built = buildFacetsFromRecords(filtered, sport);
  if (sport && !status && !q) (snap.facetsBySport ??= new Map()).set(sport, built);
  return built;
}

function runEventsFilter(snap: CatalogSnapshot, q: EventsQuery, nowMs: number) {
  const sp = q.sport ? normalizeSportFilter(q.sport) ?? q.sport.trim().toLowerCase() : null;
  const co = q.competition ? slugify(q.competition) : null, tm = q.team ? slugify(q.team) : null, bc = q.broadcaster ? slugify(q.broadcaster) : null;
  const st = q.window === "live" ? "live" : q.status ?? "active";
  let base = st === "all" ? snap.allIndices : snap.byStatus[st], nar = 0;
  const narrow = (c: number[] | undefined, tag: number) => { const a = c ?? []; if (a.length < base.length) { base = a; nar = tag; } };
  if (sp) narrow(snap.bySport.get(sp), 1);
  if (co) narrow(snap.byCompetition.get(co), 2);
  if (tm) narrow(snap.byTeam.get(tm), 3);
  if (bc) narrow(snap.byBroadcaster.get(bc), 4);

  const cSp = nar !== 1 ? sp : null, cCo = nar !== 2 ? co : null, cTm = nar !== 3 ? tm : null, cBc = nar !== 4 ? bc : null, cSt = st !== "all" && nar !== 0 ? st : null;
  const langF = q.language?.trim().toLowerCase() ?? null, provF = q.provider?.trim().toLowerCase() ?? null;
  const qLow = q.q ? q.q.trim().toLowerCase() : "", q1 = qLow && !qLow.includes(" ") ? qLow : null, qTok = qLow && !q1 ? qLow.split(/\s+/).filter(Boolean) : null;

  let fMs = q.from ? parseDateTimeMs(q.from) : null, tMs = q.to ? parseDateTimeMs(q.to) : null;
  if (q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)) { fMs = parseDateTimeMs(`${q.date}T00:00:00Z`); if (fMs !== null) tMs = fMs + 86_399_999; }
  else if (q.window && q.window !== "live") {
    const w = q.window, rel = w === "2h" ? 7_200_000 : w === "24h" ? 86_400_000 : w === "7d" ? 604_800_000 : 0;
    if (rel) { fMs = nowMs - 1_800_000; tMs = nowMs + rel; }
    else { const d0 = nowMs - (nowMs % 86_400_000); fMs = w === "tomorrow" ? d0 + 86_400_000 : d0; tMs = fMs + 86_399_999; }
  }

  const matched: IndexedEventRecord[] = [];
  let liveCount = 0, upcomingCount = 0, endedCount = 0;
  for (const idx of base) {
    const r = snap.records[idx];
    if (!r) continue;
    const e = r.event;
    if ((cSp && e.sport !== cSp) || (cCo && e.competition.id !== cCo) || (cTm && (!e.teams || (e.teams.home.id !== cTm && e.teams.away.id !== cTm))) ||
      (cBc && !r.broadcasterSlugs.includes(cBc)) || (cSt && (cSt === "active" ? r.statusRank === 2 : e.status !== cSt)) ||
      (q.kind && e.kind !== q.kind) || (q.hot !== undefined && e.hot !== q.hot) || (q.minProviders !== undefined && e.providerCount < q.minProviders) ||
      (provF && !r.providers.includes(provF)) || (langF && !r.languages.includes(langF))) continue;
    if (fMs !== null || tMs !== null) {
      if (r.startMs === null) { if (r.statusRank !== 0) continue; }
      else if ((fMs !== null && r.startMs < fMs) || (tMs !== null && r.startMs > tMs)) continue;
    }
    if (q1 ? !getSearchText(r).includes(q1) : Boolean(qTok && qTok.some((t) => !getSearchText(r).includes(t)))) continue;
    if (r.statusRank === 0) liveCount++; else if (r.statusRank === 1) upcomingCount++; else endedCount++;
    matched.push(r);
  }

  const s = q.sort;
  if (s && s !== "smart") {
    matched.sort((a, b) => (s === "time_asc" ? (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER)
      : s === "time_desc" ? (b.startMs ?? 0) - (a.startMs ?? 0)
      : s === "popularity" ? b.event.providerCount - a.event.providerCount || b.event.streamCount - a.event.streamCount
      : cmp(a.event.title, b.event.title)) || cmp(a.event.id, b.event.id));
  }
  const limit = Math.max(1, Math.min(100, q.limit ?? 25));
  const offset = q.page !== undefined && q.page >= 1 ? (q.page - 1) * limit : Math.max(0, q.offset ?? 0);
  return { matched, limit, offset, liveCount, upcomingCount, endedCount };
}

export function queryEventsSerializedFromSnapshot(snap: CatalogSnapshot, query: EventsQuery, nowMs: number): { body: string; etag?: string } {
  const { matched, limit, offset, liveCount, upcomingCount, endedCount } = runEventsFilter(snap, query, nowMs);
  if (query.includeDebug) {
    const data = matched.slice(offset, offset + limit).map((r) => ({ ...r.event, debug: r.debug }));
    const meta: CollectionMeta = { total: matched.length, returned: data.length, limit, offset, hasMore: offset + data.length < matched.length, counts: { live: liveCount, upcoming: upcomingCount, ended: endedCount }, stale: snap.stale, generatedAt: snap.generatedAt };
    return { body: JSON.stringify({ data, meta }) };
  }
  const count = Math.max(0, Math.min(matched.length, offset + limit) - offset);
  let dataStr = "", h1 = snap.fetchedAtMs ^ (matched.length * 31) ^ (offset << 8) ^ limit ^ (snap.stale ? 1 : 0);
  let h2 = 0x9e3779b9 ^ (liveCount * 17) ^ (upcomingCount * 37) ^ (endedCount * 73);
  const parts = count > 1 ? new Array<string>(count) : null;
  for (let i = 0; i < count; i++) {
    const r = matched[offset + i];
    if (!r) continue;
    const s = (r.eventJson ??= JSON.stringify(r.event));
    h1 = Math.imul(h1 ^ r.idHash, 0x01000193); h2 = Math.imul(h2 ^ (r.idHash + i), 0x85ebca6b);
    if (parts) parts[i] = s; else dataStr = s;
  }
  if (parts) dataStr = parts.join(",");
  const body = `{"data":[${dataStr}],"meta":{"total":${matched.length},"returned":${count},"limit":${limit},"offset":${offset},"hasMore":${offset + count < matched.length},"counts":{"live":${liveCount},"upcoming":${upcomingCount},"ended":${endedCount}},"stale":${snap.stale},"generatedAt":"${snap.generatedAt}"}}`;
  return { body, etag: `W/"${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${body.length.toString(16)}"` };
}
