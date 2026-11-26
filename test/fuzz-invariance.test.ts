import { describe, expect, it } from "vitest";
import { generateHeavyCatalogByProvider, generateHeavyRawStreams } from "../scripts/bench-fixtures";
import { StreamEngine } from "../src/domain/streams";
import { PROVIDERS } from "../src/data/taxonomy";
import { buildCatalogSnapshot } from "../src/domain/reconciliation";
import { decodeCncRawId } from "../src/domain/cnc";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: ReadonlyArray<T>, rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

const FIXED_NOW = Date.parse("2026-11-24T12:00:00.000Z");

describe("Deterministic Invariance & Property Fuzzing", () => {
  it("produces bit-for-bit identical catalog IDs, canonical keys, teams, titles, and statuses across 15 shuffled provider/item permutations", () => {
    const baseByProvider = generateHeavyCatalogByProvider(FIXED_NOW);
    const basePayloads = PROVIDERS.map((p) => {
      const items = baseByProvider.get(p.id) ?? [];
      return {
        provider: p.key,
        name: p.name,
        items,
        rawCount: items.length,
        exclusions: [],
        healthy: true,
      };
    });

    const baseline = buildCatalogSnapshot(basePayloads, FIXED_NOW);
    const baselineFingerprint = baseline.records.map((r) => ({
      id: r.event.id,
      canonicalKey: r.debug.canonicalKey,
      title: r.event.title,
      status: r.event.status,
      teams: r.event.teams,
      providerCount: r.event.providerCount,
    }));

    for (let trial = 1; trial <= 15; trial++) {
      const rng = mulberry32(10_000 + trial * 97);
      const shuffledPayloads = shuffle(basePayloads, rng).map((p) => ({
        ...p,
        items: shuffle(p.items, rng),
      }));
      const snap = buildCatalogSnapshot(shuffledPayloads, FIXED_NOW);
      const fp = snap.records.map((r) => ({
        id: r.event.id,
        canonicalKey: r.debug.canonicalKey,
        title: r.event.title,
        status: r.event.status,
        teams: r.event.teams,
        providerCount: r.event.providerCount,
      }));
      expect(fp).toEqual(baselineFingerprint);
      expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
    }
  });

  it("produces bit-for-bit identical ranked streams and mirror lists across 20 shuffled stream orders", () => {
    const raw = generateHeavyRawStreams().map((s) => ({ provider: s.providerKey, stream: s }));
    const baseline = StreamEngine.deduplicateAndRank(raw, "https://api.playon.dev");

    for (let trial = 1; trial <= 20; trial++) {
      const rng = mulberry32(77_000 + trial * 31);
      const shuffled = shuffle(raw, rng);
      const res = StreamEngine.deduplicateAndRank(shuffled, "https://api.playon.dev");
      expect(res.streams).toEqual(baseline.streams);
    }
  });

  it("never throws on arbitrary malformed cnc: payloads", () => {
    const rng = mulberry32(42);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=:{}[]\"'";
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rng() * 120);
      let s = "cnc:";
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(rng() * alphabet.length)];
      }
      expect(() => decodeCncRawId(s)).not.toThrow();
    }
  });

  it("maintains strict order-independence across midnight-crossing matches and club-fuzzy acronyms/subsets", () => {
    const enc = (p: string, data: object) => {
      const bytes = new TextEncoder().encode(`${p}::${JSON.stringify(data)}`);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return `cnc:${btoa(bin)}`;
    };

    const items = [
      {
        provider: "sportzx",
        name: "SportzX",
        items: [
          { id: enc("sportzx", { title: "Ratchaburi vs JDT", cat: "Football", eventInfo: { teamA: "Ratchaburi", teamB: "JDT", startTime: "2026-11-24T23:55:00Z" } }) },
          { id: enc("sportzx", { title: "Daejeon Hana vs Guoan", cat: "Football", eventInfo: { teamA: "Daejeon Hana", teamB: "Guoan", startTime: "2026-11-24T12:00:00Z" } }) },
        ],
        rawCount: 2,
        exclusions: [],
        healthy: true,
      },
      {
        provider: "playztv",
        name: "PlayZ TV",
        items: [
          { id: enc("playztv", { title: "Johor Darul Ta'zim vs Ratchaburi", cat: "Football", eventInfo: { teamA: "Johor Darul Ta'zim", teamB: "Ratchaburi", startTime: "2026-11-25T00:05:00Z" } }) },
          { id: enc("playztv", { title: "Beijing Guoan vs Daejeon Hana Citizen", cat: "Football", eventInfo: { teamA: "Beijing Guoan", teamB: "Daejeon Hana Citizen", startTime: "2026-11-24T12:15:00Z" } }) },
        ],
        rawCount: 2,
        exclusions: [],
        healthy: true,
      },
    ];

    const base = buildCatalogSnapshot(items, FIXED_NOW).events.map((e) => ({ id: e.id, title: e.title, provs: e.providerCount }));
    expect(base.length).toBe(2);
    expect(base.every((e) => e.provs === 2)).toBe(true);

    for (let trial = 1; trial <= 10; trial++) {
      const rng = mulberry32(999 + trial * 17);
      const perm = shuffle(items, rng).map((p) => ({ ...p, items: shuffle(p.items, rng) }));
      const got = buildCatalogSnapshot(perm, FIXED_NOW).events.map((e) => ({ id: e.id, title: e.title, provs: e.providerCount }));
      expect(got).toEqual(base);
    }
  });
});
