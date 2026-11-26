import { describe, expect, it } from "vitest";
import { EventIdentityEngine } from "../src/domain/identity";
import {
  classifySport,
  cleanText,
  cleanTitle,
  computeCanonicalKey,
  decodeHtmlEntities,
  extractPosterParams,
  normalizeSportFilter,
  normalizeTeamName,
  normalizeTournamentName,
  parseDateTimeMs,
  parseTeamsFromTitle,
  repairMojibake,
  slugify,
  teamCode,
} from "../src/domain/normalizer";

describe("Normalizer & EventIdentityEngine — Production Failure Modes", () => {
  it("parses ISO UTC, space-separated UTC, named timezones (IST/EST/EDT/BST/AEST/NPT), and numeric offsets accurately", () => {
    const base = Date.UTC(2026, 10, 25, 14, 0, 0);
    expect(parseDateTimeMs("2026-11-25T14:00:00Z")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 14:00:00 UTC")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 19:30:00 IST")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 09:00:00 EST")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 10:00:00 EDT")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 15:00:00 BST")).toBe(base);
    expect(parseDateTimeMs("2026-11-26 00:00:00 AEST")).toBe(base);
    expect(parseDateTimeMs("2026-11-25 19:45:00 NPT")).toBe(base);
    expect(parseDateTimeMs("2026-11-25T19:30:00+05:30")).toBe(base);
    expect(parseDateTimeMs("2026-11-25T10:00:00-0400")).toBe(base);
  });

  it("parses DMY with AM/PM, text dates, and epoch seconds vs milliseconds cleanly", () => {
    const base = Date.UTC(2026, 10, 25, 14, 0, 0);
    expect(parseDateTimeMs("25/11/2026 07:30 PM IST")).toBe(base);
    expect(parseDateTimeMs("Nov 25, 2026 14:00 GMT")).toBe(base);
    expect(parseDateTimeMs("25 Nov 2026 02:00 PM UTC")).toBe(base);
    expect(parseDateTimeMs(Math.floor(base / 1000))).toBe(base);
    expect(parseDateTimeMs(base)).toBe(base);
    expect(parseDateTimeMs(String(Math.floor(base / 1000)))).toBe(base);
    expect(parseDateTimeMs(String(base))).toBe(base);
  });

  it("handles midnight AM/PM wraparound and rejects out-of-range, zero, NaN, or garbage dates", () => {
    expect(parseDateTimeMs("25/11/2026 12:00 AM UTC")).toBe(Date.UTC(2026, 10, 25, 0, 0, 0));
    expect(parseDateTimeMs("25/11/2026 12:00 PM UTC")).toBe(Date.UTC(2026, 10, 25, 12, 0, 0));
    expect(parseDateTimeMs(0)).toBeNull();
    expect(parseDateTimeMs(-5000)).toBeNull();
    expect(parseDateTimeMs(Number.NaN)).toBeNull();
    expect(parseDateTimeMs("1995-01-01T00:00:00Z")).toBeNull();
    expect(parseDateTimeMs("not-a-date")).toBeNull();
    expect(parseDateTimeMs("")).toBeNull();
    expect(parseDateTimeMs(null)).toBeNull();
  });

  it("repairs UTF-8 double-encoded mojibake without corrupting valid Unicode strings", () => {
    const toLatin1Mojibake = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));
    expect(repairMojibake(toLatin1Mojibake("Atlético Madrid"))).toBe("Atlético Madrid");
    expect(repairMojibake(toLatin1Mojibake("Bayern München"))).toBe("Bayern München");
    expect(repairMojibake("Already Clean ASCII")).toBe("Already Clean ASCII");
    expect(repairMojibake("Atlético Madrid")).toBe("Atlético Madrid");
  });

  it("decodes named, decimal, and hex HTML entities safely", () => {
    expect(decodeHtmlEntities("Brighton &amp; Hove Albion&#39;s &#x27;Seagulls&#x27;")).toBe("Brighton & Hove Albion's 'Seagulls'");
    expect(decodeHtmlEntities("A &lt; B &gt; C &quot;D&quot;&nbsp;E")).toBe('A < B > C "D" E');
    expect(decodeHtmlEntities("&#65;&#x42;")).toBe("AB");
  });

  it("strips emojis, zero-width characters, broadcaster prefixes, and stream spam from titles", () => {
    expect(cleanText("🔴\u200B  India   vs   Australia  🏏")).toBe("India vs Australia");
    expect(cleanTitle("Sky Sports: Arsenal vs Chelsea [HD] Live Stream")).toBe("Arsenal vs Chelsea");
    expect(cleanTitle("ESPN+: Lakers vs Celtics [LIVE] - Watch Live")).toBe("Lakers vs Celtics");
    expect(cleanTitle("  |  Barça vs Real Madrid  |  ")).toBe("Barça vs Real Madrid");
  });

  it("extracts teams across vs/v./@/x delimiters, prefixes, pipe suffixes, and trailing match tags", () => {
    expect(parseTeamsFromTitle("Premier League: Arsenal vs Chelsea | Live")).toEqual(["Arsenal", "Chelsea"]);
    expect(parseTeamsFromTitle("NBA - Lakers @ Celtics")).toEqual(["Lakers", "Celtics"]);
    expect(parseTeamsFromTitle("India v. England Match 4")).toEqual(["India", "England"]);
    expect(parseTeamsFromTitle("Flamengo x Palmeiras")).toEqual(["Flamengo", "Palmeiras"]);
  });

  it("rejects non-match pseudo-delimiters and overlong garbage titles in parseTeamsFromTitle", () => {
    expect(parseTeamsFromTitle("Abu Dhabi vs T10")).toBeNull();
    expect(parseTeamsFromTitle("NFL vs Red Zone")).toBeNull();
    expect(parseTeamsFromTitle("Formula 1 Monaco Grand Prix Qualifying")).toBeNull();
    expect(parseTeamsFromTitle(`${"A".repeat(70)} vs ${"B".repeat(70)}`)).toBeNull();
  });

  it("extracts structured query params from dynamic poster URLs and promotes non-match title to tournament", () => {
    const poster =
      "https://img.example.com/card?team1=IND&team2=AUS&title=Border+Gavaskar+Trophy&sport=cricket&startTime=2026-11-25T14:00:00Z&logo1=https%3A%2F%2Fcdn.example.com%2Find.png&logo2=https%3A%2F%2Fcdn.example.com%2Faus.png&isLive=true";
    const meta = extractPosterParams(poster);
    expect(meta).not.toBeNull();
    expect(meta?.teamA).toBe("IND");
    expect(meta?.teamB).toBe("AUS");
    expect(meta?.tournament).toBe("Border Gavaskar Trophy");
    expect(meta?.title).toBeNull();
    expect(meta?.teamALogo).toBe("https://cdn.example.com/ind.png");
    expect(meta?.isLive).toBe(true);
    expect(extractPosterParams("https://img.example.com/static.jpg")).toBeNull();
  });

  it("protects non-cricket sports when a provider mislabels them as raw cricket", () => {
    expect(classifySport("cricket", "Formula 1", "Abu Dhabi Grand Prix Race", null)).toBe("motorsport");
    expect(classifySport("cricket", "Premier League", "Arsenal vs Chelsea", ["Arsenal", "Chelsea"])).toBe("football");
    expect(classifySport("cricket", "NBA Regular Season", "Lakers vs Celtics", ["Lakers", "Celtics"])).toBe("basketball");
    expect(classifySport("cricket", "ICC T20 World Cup", "India vs Pakistan", ["India", "Pakistan"])).toBe("cricket");
  });

  it("resolves contextual ambiguous team names accurately by sport", () => {
    expect(normalizeTeamName("Kings", "hockey")).toBe("Los Angeles Kings");
    expect(normalizeTeamName("Kings", "basketball")).toBe("Sacramento Kings");
    expect(normalizeTeamName("Kings", "cricket")).toBe("Punjab Kings");
    expect(normalizeTeamName("Jets", "hockey")).toBe("Winnipeg Jets");
    expect(normalizeTeamName("Jets", "american_football")).toBe("New York Jets");
    expect(normalizeTeamName("Spurs", "basketball")).toBe("San Antonio Spurs");
    expect(normalizeTeamName("Spurs", "football")).toBe("Tottenham Hotspur");
    expect(normalizeTeamName("Lions", "cricket")).toBe("England Lions");
    expect(normalizeTeamName("Lions", "american_football")).toBe("Detroit Lions");
  });

  it("normalizes diacritic aliases, club suffixes, and Utd. abbreviations consistently", () => {
    expect(normalizeTeamName("Barça", "football")).toBe("Barcelona");
    expect(normalizeTeamName("FC Bayern München", "football")).toBe("Bayern Munich");
    expect(normalizeTeamName("Man. Utd.", "football")).toBe("Manchester United");
    expect(normalizeTeamName("Sheffield Utd.", "football")).toBe("Sheffield United");
    expect(normalizeTeamName("Ivory Coast", "football")).toBe("Côte d'Ivoire");
    expect(normalizeTeamName("Turkiye", "football")).toBe("Türkiye");
    expect(slugify("Atlético Madrid")).toBe("atletico-madrid");
    expect(teamCode("Royal Challengers Bengaluru")).toBe("RCB");
    expect(teamCode("Manchester United")).toBe("MAU");
    expect(teamCode("India")).toBe("IND");
  });

  it("normalizes sport filter aliases and rejects generic bucket labels like tv/live/other", () => {
    expect(normalizeSportFilter("soccer")).toBe("football");
    expect(normalizeSportFilter("f1")).toBe("motorsport");
    expect(normalizeSportFilter("nhl")).toBe("hockey");
    expect(normalizeSportFilter("ufc")).toBe("combat");
    expect(normalizeSportFilter("American Football")).toBe("american_football");
    expect(normalizeSportFilter("tv")).toBeNull();
    expect(normalizeSportFilter("live")).toBeNull();
    expect(normalizeSportFilter("other")).toBeNull();
  });

  it("clusters tournament channels and splits motorsport sessions by circuit + session", () => {
    const f1Quali = EventIdentityEngine.parse("F1 Monaco Grand Prix Qualifying", "motorsport");
    const f1Race = EventIdentityEngine.parse("F1 Monaco Grand Prix Race", "motorsport");
    const k1 = computeCanonicalKey("motorsport", null, f1Quali, "Formula 1", "F1 Monaco Grand Prix Qualifying", Date.UTC(2026, 4, 24, 14, 0));
    const k2 = computeCanonicalKey("motorsport", null, f1Race, "Formula 1", "F1 Monaco Grand Prix Race", Date.UTC(2026, 4, 24, 14, 0));
    expect(k1.kind).toBe("session");
    expect(k2.kind).toBe("session");
    expect(k1.key).not.toBe(k2.key);
    expect(normalizeTournamentName("Live", "american_football", "NFL RedZone Live")).toBe("NFL RedZone");
  });

  it("detects gender, age-group, and squad conflicts cleanly in EventIdentityEngine", () => {
    const men = EventIdentityEngine.parse("India vs Australia", "cricket");
    const women = EventIdentityEngine.parse("India Women vs Australia Women", "cricket");
    const u19 = EventIdentityEngine.parse("India U19 vs Australia U19", "cricket");
    const aTeam = EventIdentityEngine.parse("India A vs Australia A", "cricket");
    const reserves = EventIdentityEngine.parse("Barcelona B vs Real Madrid Castilla", "football");
    const senior = EventIdentityEngine.parse("Barcelona vs Real Madrid", "football");

    expect(EventIdentityEngine.checkConflict(men, women)).toBe("CONFLICTING_GENDER");
    expect(EventIdentityEngine.checkConflict(men, u19)).toBe("CONFLICTING_AGE_GROUP");
    expect(EventIdentityEngine.checkConflict(men, aTeam)).toBe("CONFLICTING_SQUAD");
    expect(EventIdentityEngine.checkConflict(senior, reserves)).toBe("CONFLICTING_SQUAD");
  });

  it("detects format, tennis doubles, motorsport session, combat card, matchNumber, and stage conflicts", () => {
    const t20 = EventIdentityEngine.parse("India vs England 1st T20", "cricket");
    const odi = EventIdentityEngine.parse("India vs England 1st ODI", "cricket");
    const m2 = EventIdentityEngine.parse("India vs England 2nd T20", "cricket");
    const sf = EventIdentityEngine.parse("India vs England Semi-Final T20", "cricket");
    const fin = EventIdentityEngine.parse("India vs England Final T20", "cricket");
    const singles = EventIdentityEngine.parse("Alcaraz vs Sinner", "tennis");
    const doubles = EventIdentityEngine.parse("Alcaraz / Nadal vs Sinner / Berrettini", "tennis");
    const prelims = EventIdentityEngine.parse("UFC 310 Prelims", "combat");
    const mainCard = EventIdentityEngine.parse("UFC 310 Main Card", "combat");

    expect(EventIdentityEngine.checkConflict(t20, odi)).toBe("CONFLICTING_FORMAT");
    expect(EventIdentityEngine.checkConflict(t20, m2)).toBe("CONFLICTING_MATCH_NUMBER");
    expect(EventIdentityEngine.checkConflict(sf, fin)).toBe("CONFLICTING_STAGE");
    expect(EventIdentityEngine.checkConflict(singles, doubles)).toBe("CONFLICTING_FORMAT");
    expect(EventIdentityEngine.checkConflict(prelims, mainCard)).toBe("CONFLICTING_SESSION");
  });

  it("identifies 24/7 channels and returns a frozen singleton for plain zero-flag titles", () => {
    const ch = EventIdentityEngine.parse("Sky Sports News 24/7 TV Channel", "football");
    expect(ch.is24x7Channel).toBe(true);
    const plain1 = EventIdentityEngine.parse("Arsenal vs Chelsea", "football");
    const plain2 = EventIdentityEngine.parse("Liverpool vs Everton", "football");
    expect(plain1).toBe(plain2);
    expect(Object.isFrozen(plain1)).toBe(true);
    expect(plain1.canonicalDiscriminator).toBe("");
  });

  it("classifies cricket nations on cricify or tour/cup titles without hijacking unrelated sports", () => {
    expect(classifySport(null, "Bilateral Tour", "India vs South Africa", ["India", "South Africa"], "cricify")).toBe("cricket");
    expect(classifySport(null, "FIFA International Friendly", "England vs Scotland", ["England", "Scotland"], "sportzx")).toBe("football");
    expect(classifySport(null, "U19 Asia Cup", "Nepal vs UAE", ["Nepal", "UAE"])).toBe("cricket");
  });

  it("parses combat early prelims, motorsport sprint shootout, and cricket The Hundred/T10 formats", () => {
    expect(EventIdentityEngine.parse("UFC 315 Early Prelims", "combat").session).toBe("early_prelims");
    expect(EventIdentityEngine.parse("F1 Brazil Sprint Qualifying", "motorsport").session).toBe("sprint_shootout");
    expect(EventIdentityEngine.parse("London Spirit vs Oval Invincibles The Hundred", "cricket").format).toBe("the_hundred");
    expect(EventIdentityEngine.parse("Abu Dhabi T10 League", "cricket").format).toBe("t10");
  });

  it("recognizes explicit match number tags and ordinal match numbers while ignoring '3rd place' / 'first class'", () => {
    expect(EventIdentityEngine.parse("Ind vs Aus Match #3", "cricket").matchNumber).toBe("m3");
    expect(EventIdentityEngine.parse("Ind vs Aus 4th Test", "cricket").matchNumber).toBe("m4");
    expect(EventIdentityEngine.parse("Bronze Match 3rd Place Playoff", "football").matchNumber).toBeNull();
    expect(EventIdentityEngine.parse("Bronze Match 3rd Place", "football").stage).toBe("third_place");
    expect(EventIdentityEngine.parse("County First-Class Match", "cricket").matchNumber).toBeNull();
  });
});
