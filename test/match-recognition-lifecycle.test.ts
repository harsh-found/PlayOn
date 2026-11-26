import { describe, expect, it } from "vitest";
import { generateHeavyCatalogByProvider } from "../scripts/bench-fixtures";
import { computeLifecycleStatus, parseDateTimeMs, repairMojibake } from "../src/domain/normalizer";
import { PROVIDERS } from "../src/data/taxonomy";
import { buildCatalogSnapshot } from "../src/domain/reconciliation";
import type { UpstreamMeta } from "../src/types";

function encodeCnc(provider: string, data: object): string {
  const raw = `${provider}::${JSON.stringify(data)}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `cnc:${btoa(bin)}`;
}

function makeProviderBatch(
  entries: Array<{ provider: string; meta: UpstreamMeta }>
) {
  const map = new Map<string, UpstreamMeta[]>();
  for (const e of entries) {
    const arr = map.get(e.provider) ?? [];
    arr.push(e.meta);
    map.set(e.provider, arr);
  }
  return [...map.entries()].map(([provider, items]) => ({
    provider,
    name: provider,
    items,
    rawCount: items.length,
    exclusions: [],
    healthy: true,
  }));
}

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

describe("Match Recognition, Zero False Merges & Sport-Aware Lifecycle", () => {
  it("achieves exact 154-event reconciliation with zero fragmentation and zero loss on the 796-item catalog", () => {
    const byProvider = generateHeavyCatalogByProvider(NOW);
    const payloads = PROVIDERS.map((p) => {
      const items = byProvider.get(p.id) ?? [];
      return {
        provider: p.key,
        name: p.name,
        items,
        rawCount: items.length,
        exclusions: [],
        healthy: true,
      };
    });

    const snap = buildCatalogSnapshot(payloads, NOW);
    expect(snap.reconciliation.summary.rawPayloadItems).toBe(796);
    expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
    // Ground truth: 150 distinct matches (15 seeds * 10 matchdays) + 4 shows/sessions = 154
    expect(snap.reconciliation.summary.unifiedEvents).toBe(154);

    // Verify F1 Qualifying and F1 Race stay strictly separate
    const f1Events = snap.events.filter((e) => e.sport === "motorsport");
    expect(f1Events.length).toBe(2);
    expect(f1Events.some((e) => e.details?.format === "qualifying")).toBe(true);
    expect(f1Events.some((e) => e.details?.format === "race")).toBe(true);

    // Verify Türkiye vs Côte d'Ivoire round-0 (-8h ago with stale isLive: true) is properly marked ended
    const turkiyeMatches = snap.events
      .filter((e) => e.teams?.home.name === "Türkiye" || e.teams?.away.name === "Türkiye")
      .sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
    expect(turkiyeMatches.length).toBe(10);
    expect(turkiyeMatches[0]?.status).toBe("ended");
    expect(turkiyeMatches.some((e) => e.status === "live")).toBe(false);
  });

  it("unifies messy franchise, club, and mojibake aliases across providers", () => {
    const start = "2026-11-24T14:00:00Z";
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "RCB vs CSK",
              cat: "Cricket",
              eventInfo: { teamA: "RCB", teamB: "CSK", eventName: "IPL 2026", startTime: start },
            }),
          },
        },
        {
          provider: "cricify",
          meta: {
            id: encodeCnc("cricify", {
              title: "Chennai Super Kings vs Royal Challengers Bengaluru",
              cat: "Cricket",
              eventInfo: {
                teamA: "Chennai Super Kings",
                teamB: "Royal Challengers Bengaluru",
                eventName: "IPL T20",
                startTime: start,
              },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "Man Utd vs Bayern",
              cat: "Football",
              eventInfo: { teamA: "Man Utd", teamB: "Bayern", eventName: "UEFA Champions League", startTime: start },
            }),
          },
        },
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "FC Bayern München vs Manchester United",
              cat: "Football",
              eventInfo: {
                teamA: "FC Bayern MÃ¼nchen",
                teamB: "Manchester United",
                eventName: "UCL",
                startTime: start,
              },
            }),
          },
        },
      ]),
      NOW
    );

    expect(snap.events.length).toBe(2);
    expect(snap.events.every((e) => e.providerCount === 2)).toBe(true);
    expect(repairMojibake("TÃ¼rkiye")).toBe("Türkiye");
    expect(repairMojibake("CÃ´te d'Ivoire")).toBe("Côte d'Ivoire");
  });

  it("matches individual-sport surnames/initials while isolating conflicting first initials", () => {
    const start = "2026-11-24T15:00:00Z";
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        // Should merge: Alcaraz vs Sinner <-> Carlos Alcaraz vs Jannik Sinner
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "Alcaraz vs Sinner",
              cat: "Tennis",
              eventInfo: { teamA: "Alcaraz", teamB: "Sinner", eventName: "ATP Tour", startTime: start },
            }),
          },
        },
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "Carlos Alcaraz vs Jannik Sinner",
              cat: "Tennis",
              eventInfo: { teamA: "Carlos Alcaraz", teamB: "Jannik Sinner", eventName: "ATP", startTime: start },
            }),
          },
        },
        // Must NOT merge: A. Zverev vs N. Djokovic vs M. Zverev vs N. Djokovic
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "A. Zverev vs Novak Djokovic",
              cat: "Tennis",
              eventInfo: { teamA: "A. Zverev", teamB: "Novak Djokovic", eventName: "ATP", startTime: start },
            }),
          },
        },
        {
          provider: "sktech",
          meta: {
            id: encodeCnc("sktech", {
              title: "M. Zverev vs Novak Djokovic",
              cat: "Tennis",
              eventInfo: { teamA: "M. Zverev", teamB: "Novak Djokovic", eventName: "ATP", startTime: start },
            }),
          },
        },
      ]),
      NOW
    );

    expect(snap.events.length).toBe(3);
    expect(
      snap.reconciliation.preventedMerges.some((p) => p.reason === "CONFLICTING_PARTICIPANT_INITIAL")
    ).toBe(true);
  });

  it("strictly isolates Men vs Women, U19/U21, Reserves/A-teams, Doubles, and Multi-Match Series", () => {
    const start = "2026-11-24T13:00:00Z";
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "India vs Australia 1st ODI",
              cat: "Cricket",
              eventInfo: { teamA: "India", teamB: "Australia", eventName: "1st ODI", startTime: start },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "India vs Australia 2nd ODI",
              cat: "Cricket",
              eventInfo: { teamA: "India", teamB: "Australia", eventName: "2nd ODI", startTime: start },
            }),
          },
        },
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "India Women vs Australia Women",
              cat: "Cricket",
              eventInfo: { teamA: "India Women", teamB: "Australia Women", eventName: "Women's ODI", startTime: start },
            }),
          },
        },
        {
          provider: "sktech",
          meta: {
            id: encodeCnc("sktech", {
              title: "India U19 vs Australia U19",
              cat: "Cricket",
              eventInfo: { teamA: "India U19", teamB: "Australia U19", eventName: "U19 ODI", startTime: start },
            }),
          },
        },
        {
          provider: "playfy",
          meta: {
            id: encodeCnc("playfy", {
              title: "India A vs Australia A",
              cat: "Cricket",
              eventInfo: { teamA: "India A", teamB: "Australia A", eventName: "Unofficial ODI", startTime: start },
            }),
          },
        },
        {
          provider: "cricify",
          meta: {
            id: encodeCnc("cricify", {
              title: "India vs Australia T20I",
              cat: "Cricket",
              eventInfo: { teamA: "India", teamB: "Australia", eventName: "T20I Series", startTime: start },
            }),
          },
        },
      ]),
      NOW
    );

    // Every single one of those 6 matches is distinct and must remain isolated
    expect(snap.events.length).toBe(6);
    expect(snap.reconciliation.summary.preventedFalseMerges).toBeGreaterThanOrEqual(5);
  });

  it("prevents cross-sport mascot collisions for Kings/Rangers/Giants", () => {
    const start = "2026-11-24T19:00:00Z";
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "Kings vs Rangers",
              cat: "TV",
              eventInfo: { teamA: "Kings", teamB: "Rangers", eventCat: "TV", eventName: "Live TV", startTime: start },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "Kings vs Lakers",
              cat: "Basketball",
              eventInfo: { teamA: "Kings", teamB: "Lakers", eventName: "NBA", startTime: start },
            }),
          },
        },
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "Kings vs Rangers",
              cat: "Ice Hockey",
              eventInfo: { teamA: "Kings", teamB: "Rangers", eventName: "NHL", startTime: start },
            }),
          },
        },
      ]),
      NOW
    );

    const ambiguous = snap.events.find((e) => e.sport === "other");
    expect(ambiguous).toBeDefined(); // Never misclassified as basketball
    const nba = snap.events.find((e) => e.sport === "basketball");
    expect(nba?.teams?.home.name).toBe("Sacramento Kings");
    const nhl = snap.events.find((e) => e.sport === "hockey");
    expect(nhl?.teams?.home.name).toBe("Los Angeles Kings");
    expect(nhl?.teams?.away.name).toBe("New York Rangers");
  });

  it("enforces sport-aware lifecycle windows and strict date/timezone parsing", () => {
    // Stale football live flag (-6h) -> ended
    expect(computeLifecycleStatus("football", null, NOW - 6 * 3600_000, null, true, false, NOW)).toBe("ended");
    // Active ODI started -6h ago -> still live (9h window)
    expect(computeLifecycleStatus("cricket", "odi", NOW - 6 * 3600_000, null, true, false, NOW)).toBe("live");
    // Active Test match started 3 days ago -> still live (5d window)
    expect(computeLifecycleStatus("cricket", "test", NOW - 72 * 3600_000, null, true, false, NOW)).toBe("live");
    // Absurd future live flag (+5h) -> upcoming
    expect(computeLifecycleStatus("football", null, NOW + 5 * 3600_000, null, true, false, NOW)).toBe("upcoming");

    // Multi-TZ parsing & never fakes Date.now()
    expect(parseDateTimeMs("2026-11-24 17:30 IST")).toBe(Date.UTC(2026, 10, 24, 12, 0, 0));
    expect(parseDateTimeMs("24/11/2026 07:00 AM EST")).toBe(Date.UTC(2026, 10, 24, 12, 0, 0));
    expect(parseDateTimeMs(1795521600)).toBe(1795521600 * 1000);
    expect(parseDateTimeMs("")).toBeNull();
    expect(parseDateTimeMs("not-a-date")).toBeNull();

    // Overtime / rain grace windows keep live 5-set tennis & football overtime alive
    expect(computeLifecycleStatus("tennis", null, NOW - 4.5 * 3600_000, null, true, false, NOW)).toBe("live");
    expect(computeLifecycleStatus("football", null, NOW - 2.6 * 3600_000, null, true, false, NOW)).toBe("live");
    // Explicit ended flag overrides active window
    expect(computeLifecycleStatus("cricket", "odi", NOW - 2 * 3600_000, null, false, true, NOW)).toBe("ended");
  });

  it("handles real live-upstream edge cases: dotted U.A.E, IND-A, Pohang Steelers football, club acronyms/subsets, and Italia T10", () => {
    const start = "2026-11-24T10:30:00Z";
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        // 1. India A vs U.A.E / IND-A vs UAE / India A vs United Arab Emirates -> 1 event titled "India A vs United Arab Emirates"
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "India A vs U.A.E",
              cat: "Cricket",
              eventInfo: { teamA: "India A", teamB: "U.A.E", eventName: "Asia Cup Rising Stars", startTime: start },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "IND-A vs UAE",
              cat: "Cricket",
              eventInfo: { teamA: "IND-A", teamB: "UAE", eventName: "Asia Cup Rising Stars", startTime: start },
            }),
          },
        },
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "India A vs United Arab Emirates",
              cat: "Cricket",
              eventInfo: {
                teamA: "India A",
                teamB: "United Arab Emirates",
                eventName: "Men's Asia Cup Rising Stars 2026",
                startTime: start,
              },
            }),
          },
        },
        // 2. Pohang Steelers (AFC football) MUST stay football, NOT american_football
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "Kyoto Sanga vs Pohang Steelers",
              cat: "TV",
              eventInfo: { teamA: "Kyoto Sanga", teamB: "Pohang Steelers", eventName: "AFC Champions League", startTime: start },
            }),
          },
        },
        {
          provider: "playfy",
          meta: {
            id: encodeCnc("playfy", {
              title: "Kyoto Sanga vs Pohang Steelers",
              cat: "Football",
              eventInfo: { teamA: "Kyoto Sanga", teamB: "Pohang Steelers", eventName: "Football", startTime: start },
            }),
          },
        },
        // 3. Club token subset: Daejeon Hana vs Guoan <-> Daejeon Hana Citizen vs Beijing Guoan
        {
          provider: "sktech",
          meta: {
            id: encodeCnc("sktech", {
              title: "Daejeon Hana vs Guoan",
              cat: "Football",
              eventInfo: { teamA: "Daejeon Hana", teamB: "Guoan", eventName: "AFC Champions League", startTime: start },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "Daejeon Hana Citizen vs Beijing Guoan",
              cat: "Football",
              eventInfo: { teamA: "Daejeon Hana Citizen", teamB: "Beijing Guoan", eventName: "AFC Champions League", startTime: start },
            }),
          },
        },
        // 4. Club acronym: JDT <-> Johor Darul Ta'zim
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "Ratchaburi vs JDT",
              cat: "Football",
              eventInfo: { teamA: "Ratchaburi", teamB: "JDT", eventName: "AFC Champions League", startTime: start },
            }),
          },
        },
        {
          provider: "playfy",
          meta: {
            id: encodeCnc("playfy", {
              title: "Ratchaburi vs Johor Darul Ta'zim",
              cat: "Football",
              eventInfo: { teamA: "Ratchaburi", teamB: "Johor Darul Ta'zim", eventName: "AFC Champions League", startTime: start },
            }),
          },
        },
        // 5. Italia T10 MUST NOT be hijacked into Abu Dhabi T10 League
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "Italia T10",
              cat: "Cricket",
              eventInfo: { eventName: "Italia T10 League", startTime: start },
            }),
          },
        },
      ]),
      NOW
    );

    expect(snap.events.length).toBe(5);
    const indA = snap.events.find((e) => e.title.includes("India A"));
    expect(indA?.providerCount).toBe(3);
    expect(indA?.title).toBe("India A vs United Arab Emirates");

    const pohang = snap.events.find((e) => e.title.includes("Pohang Steelers"));
    expect(pohang?.sport).toBe("football");
    expect(pohang?.providerCount).toBe(2);

    const daejeon = snap.events.find((e) => e.title.includes("Daejeon"));
    expect(daejeon?.providerCount).toBe(2);

    const jdt = snap.events.find((e) => e.title.includes("Ratchaburi"));
    expect(jdt?.providerCount).toBe(2);

    const italia = snap.events.find((e) => e.title.includes("Italia"));
    expect(italia?.competition.name).not.toContain("Abu Dhabi");
  });

  it("reconciles midnight-crossing times (23:55 vs 00:05) and vetoes UFC Prelims vs Main Card & 24/7 channels vs live matches", () => {
    const snap = buildCatalogSnapshot(
      makeProviderBatch([
        // Midnight crossing match (10 minutes apart across UTC date boundary) -> MUST merge
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "Brazil vs Argentina",
              cat: "Football",
              eventInfo: { teamA: "Brazil", teamB: "Argentina", eventName: "World Cup Qualifiers", startTime: "2026-11-24T23:55:00Z" },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "Argentina vs Brazil",
              cat: "Football",
              eventInfo: { teamA: "Argentina", teamB: "Brazil", eventName: "CONMEBOL Qualifiers", startTime: "2026-11-25T00:05:00Z" },
            }),
          },
        },
        // Midnight crossing show -> MUST merge
        {
          provider: "livxow",
          meta: {
            id: encodeCnc("livxow", {
              title: "WWE Monday Night Raw",
              cat: "Combat Sports",
              eventInfo: { eventName: "WWE", startTime: "2026-11-24T23:55:00Z" },
            }),
          },
        },
        {
          provider: "sktech",
          meta: {
            id: encodeCnc("sktech", {
              title: "WWE Monday Night Raw",
              cat: "Combat Sports",
              eventInfo: { eventName: "WWE", startTime: "2026-11-25T00:05:00Z" },
            }),
          },
        },
        // UFC Prelims vs Main Card at same time -> MUST stay separate
        {
          provider: "sportzx",
          meta: {
            id: encodeCnc("sportzx", {
              title: "UFC 335 Prelims",
              cat: "Combat Sports",
              eventInfo: { eventName: "UFC 335", startTime: "2026-11-25T01:00:00Z" },
            }),
          },
        },
        {
          provider: "playztv",
          meta: {
            id: encodeCnc("playztv", {
              title: "UFC 335 Main Card",
              cat: "Combat Sports",
              eventInfo: { eventName: "UFC 335", startTime: "2026-11-25T01:00:00Z" },
            }),
          },
        },
        // 24/7 Channel vs Live Match -> MUST stay separate
        {
          provider: "playfy",
          meta: {
            id: encodeCnc("playfy", {
              title: "Sky Sports Cricket 24/7",
              cat: "Cricket",
              eventInfo: { eventName: "24/7 Live Channel" },
            }),
          },
        },
        {
          provider: "cricify",
          meta: {
            id: encodeCnc("cricify", {
              title: "England vs South Africa",
              cat: "Cricket",
              eventInfo: { teamA: "England", teamB: "South Africa", eventName: "Test Series", startTime: "2026-11-24T11:00:00Z" },
            }),
          },
        },
      ]),
      NOW
    );

    const braArg = snap.events.filter((e) => e.title.includes("Brazil"));
    expect(braArg.length).toBe(1);
    expect(braArg[0]?.providerCount).toBe(2);

    const rawShows = snap.events.filter((e) => e.title.includes("Monday Night Raw"));
    expect(rawShows.length).toBe(1);
    expect(rawShows[0]?.providerCount).toBe(2);

    const ufc = snap.events.filter((e) => e.title.includes("UFC 335"));
    expect(ufc.length).toBe(2);
    expect(ufc.some((e) => e.details?.session === "prelims")).toBe(true);
    expect(ufc.some((e) => e.details?.session === "main_card")).toBe(true);

    const ch247 = snap.events.find((e) => e.title.includes("Sky Sports Cricket"));
    expect(ch247?.kind).toBe("channel");
  });
});
