import { describe, expect, it } from "vitest";
import { computeLifecycleStatus } from "../src/domain/normalizer";
import { buildCatalogSnapshot, hydrateSnapshot, serializeSnapshot, type ProviderCatalogResult } from "../src/domain/reconciliation";
import type { UpstreamMeta } from "../src/types";

const NOW = Date.parse("2026-11-25T14:00:00.000Z");

function encodeItem(provider: string, payload: Record<string, unknown>, overrides?: Partial<UpstreamMeta>): UpstreamMeta {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(`${provider}:${JSON.stringify(payload)}`)));
  return { id: `cnc:${b64}`, type: "tv", name: String(payload.title ?? ""), ...overrides };
}

function makePayload(provider: string, items: UpstreamMeta[], healthy = true): ProviderCatalogResult {
  return { provider, name: provider, items, rawCount: items.length, exclusions: [], healthy };
}

describe("Reconciliation Engine & Lifecycle Edge Cases", () => {
  it("merges reversed home/away order across providers and increments reversedHomeAwayResolved", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "Arsenal vs Chelsea", eventInfo: { eventCat: "Football", eventName: "Premier League", teamA: "Arsenal", teamB: "Chelsea", startTime: "2026-11-25T15:00:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "Chelsea vs Arsenal", eventInfo: { eventCat: "Football", eventName: "Premier League", teamA: "Chelsea", teamB: "Arsenal", startTime: "2026-11-25T15:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]?.providerCount).toBe(2);
    expect(snap.reconciliation.summary.reversedHomeAwayResolved).toBe(1);
    expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
  });

  it("merges near-time fixtures within 4h window across midnight boundary (Pass 1 sliding proximity)", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "Lakers vs Celtics", eventInfo: { eventCat: "Basketball", eventName: "NBA", teamA: "Lakers", teamB: "Celtics", startTime: "2026-11-25T23:30:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "Los Angeles Lakers vs Boston Celtics", eventInfo: { eventCat: "Basketball", eventName: "NBA", teamA: "Los Angeles Lakers", teamB: "Boston Celtics", startTime: "2026-11-26T00:30:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(1);
    expect(snap.reconciliation.summary.reconciledNearTime).toBe(1);
  });

  it("prevents merging same teams more than 4h apart across date buckets and logs EXCEEDED_TIME_WINDOW", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "River Plate vs Boca Juniors", eventInfo: { eventCat: "Football", eventName: "Cup", teamA: "River Plate", teamB: "Boca Juniors", startTime: "2026-11-25T22:00:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "River Plate vs Boca Juniors", eventInfo: { eventCat: "Football", eventName: "Cup", teamA: "River Plate", teamB: "Boca Juniors", startTime: "2026-11-26T04:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(2);
    expect(snap.reconciliation.preventedMerges.some((p) => p.reason === "EXCEEDED_TIME_WINDOW")).toBe(true);
  });

  it("resolves same-kickoff cricket format contradiction (Australia vs England T20 vs ODI) by duration/competition weight", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "Australia vs England", eventInfo: { eventCat: "Cricket", eventName: "ODI", teamA: "Australia", teamB: "England", startTime: "2026-11-25T14:00:00Z", endTime: "2026-11-25T18:00:00Z" } }),
      ]),
      makePayload("cricify", [
        encodeItem("cricify", { title: "Australia vs England T20", eventInfo: { eventCat: "Cricket", eventName: "ICC T20 World Cup", teamA: "Australia", teamB: "England", startTime: "2026-11-25T14:00:00Z", endTime: "2026-11-25T18:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]?.details?.format).toBe("t20");
    expect(snap.reconciliation.summary.reconciledCrossFormat).toBe(1);
  });

  it("refuses cross-format cricket merge when kickoff delta exceeds 60m or match numbers conflict", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "India vs England 1st T20", eventInfo: { eventCat: "Cricket", eventName: "T20 Series", teamA: "India", teamB: "England", startTime: "2026-11-25T14:00:00Z" } }),
      ]),
      makePayload("cricify", [
        encodeItem("cricify", { title: "India vs England 1st ODI", eventInfo: { eventCat: "Cricket", eventName: "ODI Series", teamA: "India", teamB: "England", startTime: "2026-11-25T16:30:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(2);
    expect(snap.reconciliation.preventedMerges.some((p) => p.reason === "CONFLICTING_FORMAT")).toBe(true);
  });

  it("rescues unclassified 'other' sport items into concrete sport matches while blocking incompatible sports", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "Real Madrid vs Barcelona", eventInfo: { eventCat: "Football", eventName: "LaLiga", teamA: "Real Madrid", teamB: "Barcelona", startTime: "2026-11-25T19:00:00Z" } }),
      ]),
      makePayload("playfy", [
        encodeItem("playfy", { title: "Real Madrid vs Barcelona", eventInfo: { eventCat: "Other", eventName: "Live Match", teamA: "Real Madrid", teamB: "Barcelona", startTime: "2026-11-25T19:00:00Z" } }),
      ]),
      makePayload("cricify", [
        encodeItem("cricify", { title: "Real Madrid vs Barcelona", eventInfo: { eventCat: "Basketball", eventName: "Euroleague", teamA: "Real Madrid", teamB: "Barcelona", startTime: "2026-11-25T19:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(2);
    const football = snap.events.find((e) => e.sport === "football");
    const basketball = snap.events.find((e) => e.sport === "basketball");
    expect(football?.providerCount).toBe(2);
    expect(basketball?.providerCount).toBe(1);
    expect(snap.reconciliation.preventedMerges.some((p) => p.reason === "INCOMPATIBLE_SPORT")).toBe(true);
  });

  it("attaches nodate feed to the dated fixture closest to nowMs", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "India vs Pakistan", eventInfo: { eventCat: "Cricket", eventName: "Asia Cup", teamA: "India", teamB: "Pakistan", startTime: "2026-11-25T14:30:00Z" } }),
        encodeItem("sportzx", { title: "India vs Pakistan", eventInfo: { eventCat: "Cricket", eventName: "Asia Cup", teamA: "India", teamB: "Pakistan", startTime: "2026-11-30T14:30:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "India vs Pakistan", eventInfo: { eventCat: "Cricket", eventName: "Asia Cup", teamA: "India", teamB: "Pakistan" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(2);
    const closest = snap.events.find((e) => e.startAt?.startsWith("2026-11-25"));
    const later = snap.events.find((e) => e.startAt?.startsWith("2026-11-30"));
    expect(closest?.providerCount).toBe(2);
    expect(later?.providerCount).toBe(1);
    expect(snap.reconciliation.summary.reconciledNoDate).toBe(1);
  });

  it("matches individual sport participants by surname (Pass 2) and blocks conflicting first initials (A. vs M. Zverev)", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "C. Alcaraz vs J. Sinner", eventInfo: { eventCat: "Tennis", eventName: "ATP Finals", teamA: "C. Alcaraz", teamB: "J. Sinner", startTime: "2026-11-25T16:00:00Z" } }),
        encodeItem("sportzx", { title: "A. Zverev vs D. Medvedev", eventInfo: { eventCat: "Tennis", eventName: "ATP Finals", teamA: "A. Zverev", teamB: "D. Medvedev", startTime: "2026-11-25T18:00:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "Alcaraz vs Sinner", eventInfo: { eventCat: "Tennis", eventName: "ATP Finals", teamA: "Alcaraz", teamB: "Sinner", startTime: "2026-11-25T16:15:00Z" } }),
        encodeItem("playztv", { title: "M. Zverev vs D. Medvedev", eventInfo: { eventCat: "Tennis", eventName: "ATP Finals", teamA: "M. Zverev", teamB: "D. Medvedev", startTime: "2026-11-25T18:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(3);
    expect(snap.reconciliation.summary.reconciledParticipantSurname).toBe(1);
    expect(snap.reconciliation.preventedMerges.some((p) => p.reason === "CONFLICTING_PARTICIPANT_INITIAL")).toBe(true);
  });

  it("merges club acronyms and subset names within 2h (Pass 2B) without merging generic-only club tokens", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "Atletico Bilbao vs Real Sociedad", eventInfo: { eventCat: "Football", eventName: "LaLiga", teamA: "Athletic Bilbao", teamB: "Real Sociedad", startTime: "2026-11-25T19:00:00Z" } }),
        encodeItem("sportzx", { title: "Leeds United vs Sheffield United", eventInfo: { eventCat: "Football", eventName: "Championship", teamA: "Leeds United", teamB: "Sheffield United", startTime: "2026-11-25T19:00:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "Bilbao vs Sociedad", eventInfo: { eventCat: "Football", eventName: "LaLiga", teamA: "Bilbao", teamB: "Sociedad", startTime: "2026-11-25T19:30:00Z" } }),
        encodeItem("playztv", { title: "Oxford United vs Cambridge United", eventInfo: { eventCat: "Football", eventName: "League One", teamA: "Oxford United", teamB: "Cambridge United", startTime: "2026-11-25T19:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(3);
    expect(snap.reconciliation.summary.reconciledClubFuzzy).toBe(1);
  });

  it("merges duplicate show feeds within 4h (Pass 3) while keeping F1 FP1, Qualifying, and Race separate", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "WWE Monday Night Raw", eventInfo: { eventCat: "Combat", eventName: "WWE", startTime: "2026-11-25T23:30:00Z" } }),
        encodeItem("sportzx", { title: "F1 Qatar Grand Prix FP1", eventInfo: { eventCat: "Motorsport", eventName: "Formula 1", startTime: "2026-11-25T12:00:00Z" } }),
        encodeItem("sportzx", { title: "F1 Qatar Grand Prix Qualifying", eventInfo: { eventCat: "Motorsport", eventName: "Formula 1", startTime: "2026-11-25T15:00:00Z" } }),
      ]),
      makePayload("playztv", [
        encodeItem("playztv", { title: "WWE Monday Night Raw", eventInfo: { eventCat: "Combat", eventName: "WWE", startTime: "2026-11-26T00:30:00Z" } }),
        encodeItem("playztv", { title: "F1 Qatar Grand Prix Race", eventInfo: { eventCat: "Motorsport", eventName: "Formula 1", startTime: "2026-11-25T17:00:00Z" } }),
      ]),
    ], NOW);

    expect(snap.events).toHaveLength(4);
    const wwe = snap.events.find((e) => e.title.includes("Raw"));
    expect(wwe?.providerCount).toBe(2);
  });

  it("computes lifecycle status accurately across cricket Test (5d), T20, football, and future isLive sanity clamp", () => {
    // 3 days into a 5-day Test match -> still live
    expect(computeLifecycleStatus("cricket", "test", NOW - 3 * 86_400_000, null, true, false, NOW)).toBe("live");
    // 6 days after a 5-day Test match -> ended
    expect(computeLifecycleStatus("cricket", "test", NOW - 6 * 86_400_000, null, true, false, NOW)).toBe("ended");
    // Football 2.5h + 45m grace = 195m -> ended at 210m
    expect(computeLifecycleStatus("football", null, NOW - 210 * 60_000, null, true, false, NOW)).toBe("ended");
    // Bogus provider isLive=true for a match starting 4 hours in the future -> clamped to upcoming
    expect(computeLifecycleStatus("football", null, NOW + 4 * 3600_000, null, true, false, NOW)).toBe("upcoming");
    // Match starting in 10 minutes with no explicit live flag -> live pre-show window
    expect(computeLifecycleStatus("cricket", "t20", NOW + 10 * 60_000, null, false, false, NOW)).toBe("live");
  });

  it("marks events ended past explicit endMs + 30m cutoff or when all providers report ended", () => {
    expect(computeLifecycleStatus("football", null, NOW - 150 * 60_000, NOW - 35 * 60_000, true, false, NOW)).toBe("ended");
    expect(computeLifecycleStatus("football", null, NOW - 60 * 60_000, null, false, true, NOW)).toBe("ended");
    expect(computeLifecycleStatus("football", null, null, null, false, false, NOW)).toBe("upcoming");
  });

  it("preserves full events, indices, facets, and counts across serializeSnapshot -> hydrateSnapshot round-trip", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "India vs Australia", eventInfo: { eventCat: "Cricket", eventName: "ICC T20 World Cup", teamA: "India", teamB: "Australia", startTime: "2026-11-25T14:00:00Z", isLive: true } }),
        encodeItem("sportzx", { title: "Arsenal vs Chelsea", eventInfo: { eventCat: "Football", eventName: "Premier League", teamA: "Arsenal", teamB: "Chelsea", startTime: "2026-11-25T18:00:00Z" } }),
      ]),
    ], NOW);

    const json = serializeSnapshot(snap);
    const hydrated = hydrateSnapshot(json);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.events).toEqual(snap.events);
    expect(hydrated?.facets).toEqual(snap.facets);
    expect(hydrated?.byId.size).toBe(snap.byId.size);
    expect(hydrated?.bySport.get("cricket")).toHaveLength(1);
    expect(hydrated?.byTeam.get("india")).toHaveLength(1);
  });

  it("rejects corrupt JSON and unsupported schema versions in hydrateSnapshot", () => {
    expect(hydrateSnapshot("{broken json")).toBeNull();
    expect(hydrateSnapshot(JSON.stringify({ v: 1, entries: [] }))).toBeNull();
    expect(hydrateSnapshot(JSON.stringify({ v: 2, entries: "not-array" }))).toBeNull();
  });

  it("keeps verified_zero_loss accounting accurate when one provider fails completely", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "India vs Australia", eventInfo: { eventCat: "Cricket", eventName: "Series", teamA: "India", teamB: "Australia", startTime: "2026-11-25T15:00:00Z" } }),
      ], true),
      makePayload("playztv", [], false),
    ], NOW);

    expect(snap.degraded).toBe(true);
    expect(snap.healthyProviders).toBe(1);
    expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
    expect(snap.reconciliation.summary.status).toBe("verified_zero_loss");
  });

  it("formats display team names with Women / U19 / A-team qualifiers without mutating canonical team IDs", () => {
    const snap = buildCatalogSnapshot([
      makePayload("sportzx", [
        encodeItem("sportzx", { title: "India Women vs England Women", eventInfo: { eventCat: "Cricket", eventName: "Women's T20", teamA: "India Women", teamB: "England Women", startTime: "2026-11-25T15:00:00Z" } }),
        encodeItem("sportzx", { title: "India U19 vs Australia U19", eventInfo: { eventCat: "Cricket", eventName: "U19 World Cup", teamA: "India U19", teamB: "Australia U19", startTime: "2026-11-25T16:00:00Z" } }),
      ]),
    ], NOW);

    const w = snap.events.find((e) => e.details?.gender === "women");
    const u19 = snap.events.find((e) => e.details?.ageGroup === "u19");
    expect(w?.teams?.home.name).toBe("India Women");
    expect(w?.teams?.home.id).toBe("india");
    expect(u19?.teams?.home.name).toBe("India U19");
    expect(u19?.teams?.home.id).toBe("india");
  });
});
