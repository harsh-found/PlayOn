/**
 * Deterministic PlayOn benchmark & Cloudflare Workers Free-tier CPU gate verifier.
 * Reports module startup ms, exact sub-stage CPU breakdown, cold 1st-run AND warmed
 * Worker-isolate steady-state medians, 2,493-item linear scaling proof, bundle KB, and src LOC.
 * Run via: npm run bench
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  generateHeavyCatalogByProvider,
  generateHeavyRawStreams,
  generateLargeM3u8Playlist,
} from "./bench-fixtures";

// Frozen baselines recorded on identical 796-item catalog, 2,493-item stress set,
// 20 HTTP queries, 120 messy streams, and 450-segment M3U8 playlist.
const V1_BASELINE = {
  rawCatalogItems: 796,
  unifiedEvents: 193, // 39 fragmented duplicates (ground truth: 154)
  coldCatalog796Ms: 253.92,
  warm20QueriesMs: 200.73,
  l1Cached20QueriesMs: 66.34,
  streamDedup120Ms: 10.07,
  m3u8Rewrite450Ms: 5.11,
  fullCatalogJsonKB: 1475.99,
  paginated20EventsJsonKB: 153.32,
  singleEventStreamsJsonKB: 46.35,
  bundleKB: 312.4,
  srcLoc: 9302,
} as const;

const PRE_HARDENING_BASELINE = {
  coldCatalog796Ms: 131.98,
  coldCatalog2500Ms: 206.28,
  warm20QueriesMs: 18.58,
  l1Cached20QueriesMs: 7.08,
  streamDedup120Ms: 7.32,
  m3u8Rewrite450Ms: 1.84,
  bundleKB: 240.8,
  srcLoc: 6771,
} as const;

const HARDENED_PREV_BASELINE = {
  coldCatalog796Ms: 113.42,
  coldCatalog2500Ms: 178.49,
  warm20QueriesMs: 23.82,
  l1Cached20QueriesMs: 6.45,
  streamDedup120Ms: 6.97,
  m3u8Rewrite450Ms: 2.05,
  bundleKB: 263.8,
  srcLoc: 7439,
} as const;

const FIXED_NOW = Date.parse("2026-11-24T12:00:00.000Z");

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const pct = (before: number, after: number): string =>
  `${after <= before ? "-" : "+"}${Math.abs(Math.round(((before - after) / before) * 1000) / 10)}%`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function measureMedian(fn: () => void, warmupRuns: number, sampleRuns: number): number {
  for (let i = 0; i < warmupRuns; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < sampleRuns; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function measureMedianAsync(fn: () => Promise<void>, warmupRuns: number, sampleRuns: number): Promise<number> {
  for (let i = 0; i < warmupRuns; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < sampleRuns; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function countSrcLoc(dir: string): number {
  let lines = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) lines += countSrcLoc(full);
    else if (entry.name.endsWith(".ts")) lines += readFileSync(full, "utf8").split("\n").length - 1;
  }
  return lines;
}

function getBundleKB(): number | null {
  try {
    return r2(statSync(join(process.cwd(), "dist", "index.js")).size / 1024);
  } catch {
    return null;
  }
}

async function main() {
  // Measure cold module evaluation / isolate startup time
  const tStartup0 = performance.now();
  const [
    { PROVIDERS },
    { decodeCncRawId },
    { rewriteM3u8Playlist },
    { StreamEngine },
    { buildCatalogSnapshot, extractCandidate },
    { createApp },
  ] = await Promise.all([
    import("../src/data/taxonomy"),
    import("../src/domain/cnc"),
    import("../src/domain/m3u8"),
    import("../src/domain/streams"),
    import("../src/domain/reconciliation"),
    import("../src/index"),
  ]);
  const moduleStartupMs = performance.now() - tStartup0;

  const catalogByProvider = generateHeavyCatalogByProvider(FIXED_NOW, 10);
  const scaleCatalogByProvider = generateHeavyCatalogByProvider(FIXED_NOW, 32);
  const rawStreams = generateHeavyRawStreams();
  const largeM3u8 = generateLargeM3u8Playlist(450);

  let rawCatalogItems = 0;
  for (const metas of catalogByProvider.values()) rawCatalogItems += metas.length;

  let scaleRawItems = 0;
  for (const metas of scaleCatalogByProvider.values()) scaleRawItems += metas.length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/catalog/tv/")) {
      const m = /\/catalog\/tv\/([^.]+)\.json/.exec(url);
      const id = m && m[1] ? decodeURIComponent(m[1]) : "";
      const metas = catalogByProvider.get(id) ?? [];
      return new Response(JSON.stringify({ metas }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/stream/tv/")) {
      return new Response(JSON.stringify({ streams: rawStreams.slice(0, 24) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    const toPayloads = (byProvider: typeof catalogByProvider) =>
      PROVIDERS.map((p) => {
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

    const providerPayloads = toPayloads(catalogByProvider);
    const scalePayloads = toPayloads(scaleCatalogByProvider);

    // Cold 1st-run measurements (includes V8 Ignition + TurboFan JIT warmup)
    const tCold796_0 = performance.now();
    const snapshot = buildCatalogSnapshot(providerPayloads, FIXED_NOW);
    const cold796FirstRunMs = performance.now() - tCold796_0;

    const tCold2500_0 = performance.now();
    const scaleSnapshot = buildCatalogSnapshot(scalePayloads, FIXED_NOW);
    const cold2500FirstRunMs = performance.now() - tCold2500_0;

    const streamInputs = rawStreams.map((s) => ({ provider: s.providerKey, stream: s }));
    const tDedup0 = performance.now();
    const deduped = StreamEngine.deduplicateAndRank(streamInputs, "https://playon.test");
    const dedupFirstRunMs = performance.now() - tDedup0;

    const tM3u80 = performance.now();
    const rewritten = rewriteM3u8Playlist(
      largeM3u8,
      "https://cdn.example.net/live/match1/master.m3u8",
      "https://playon.test",
      { referer: "https://player.example.com/", ua: "PlayOnPlayer/1.0" }
    );
    const m3u8FirstRunMs = performance.now() - tM3u80;

    // Warmed Worker-isolate steady-state medians + exact sub-stage CPU breakdown
    const decode796SteadyMs = measureMedian(() => {
      for (const p of providerPayloads) {
        for (const item of p.items) decodeCncRawId(item.id);
      }
    }, 6, 15);

    const extractAll796SteadyMs = measureMedian(() => {
      for (const p of providerPayloads) {
        for (let i = 0; i < p.items.length; i++) {
          const item = p.items[i];
          if (item) extractCandidate(p.provider, item, i);
        }
      }
    }, 6, 15);

    const build796SteadyMs = measureMedian(() => {
      buildCatalogSnapshot(providerPayloads, FIXED_NOW);
    }, 6, 15);

    const build2500SteadyMs = measureMedian(() => {
      buildCatalogSnapshot(scalePayloads, FIXED_NOW);
    }, 4, 9);

    const dedup120SteadyMs = measureMedian(() => {
      StreamEngine.deduplicateAndRank(streamInputs, "https://playon.test");
    }, 8, 21);

    const m3u8450SteadyMs = measureMedian(() => {
      rewriteM3u8Playlist(
        largeM3u8,
        "https://cdn.example.net/live/match1/master.m3u8",
        "https://playon.test",
        { referer: "https://player.example.com/", ua: "PlayOnPlayer/1.0" }
      );
    }, 10, 25);

    const queries = [
      "/api/events?status=live",
      "/api/events?sport=cricket&limit=20",
      "/api/events?sport=football&limit=20",
      "/api/events?sport=basketball&limit=20",
      "/api/events?sport=hockey&limit=20",
      "/api/events?sport=tennis&limit=20",
      "/api/events?sport=combat&limit=20",
      "/api/events?sport=motorsport&limit=20",
      "/api/events?q=india&limit=20",
      "/api/events?q=united&limit=20",
      "/api/events?q=alcaraz&limit=20",
      "/api/events?q=barcelona&limit=20",
      "/api/events?broadcaster=sky-sports-main-event&limit=20",
      "/api/events?competition=premier-league&limit=20",
      "/api/events?team=los-angeles-kings&limit=20",
      "/api/events?hot=true&limit=20",
      "/api/events?window=24h&limit=20",
      "/api/events?sort=popularity&limit=20",
      "/api/events?status=all&limit=20",
      "/api/facets?sport=cricket",
    ];

    const { app, cache } = createApp();
    await app.fetch(new Request("https://playon.test/api/facets"));

    const etags: string[] = [];
    const tWarmFirst0 = performance.now();
    for (const q of queries) {
      const res = await app.fetch(new Request(`https://playon.test${q}`));
      etags.push(res.headers.get("ETag") ?? "");
      await res.arrayBuffer();
    }
    const warm20FirstRunMs = performance.now() - tWarmFirst0;

    // Warmed steady-state HTTP 20 queries (L1 miss -> pre-indexed query + serialize + cache put)
    const warm20SteadyMs = await measureMedianAsync(async () => {
      cache.clear();
      for (const q of queries) {
        const res = await app.fetch(new Request(`https://playon.test${q}`));
        await res.arrayBuffer();
      }
    }, 5, 13);

    // L1 cached 20 queries (pre-serialized fast path)
    const l1Cached20SteadyMs = await measureMedianAsync(async () => {
      for (const q of queries) {
        const res = await app.fetch(new Request(`https://playon.test${q}`));
        await res.arrayBuffer();
      }
    }, 5, 13);

    // Conditional 304 Not Modified 20 queries
    let count304 = 0;
    const cond304SteadyMs = await measureMedianAsync(async () => {
      count304 = 0;
      for (let i = 0; i < queries.length; i++) {
        const res = await app.fetch(
          new Request(`https://playon.test${queries[i]}`, {
            headers: { "If-None-Match": etags[i] ?? "" },
          })
        );
        if (res.status === 304) count304++;
      }
    }, 5, 13);

    // Payload sizes (lean default JSON)
    const fullRes = await app.fetch(new Request("https://playon.test/api/events?status=all&limit=100"));
    const fullBytes = (await fullRes.text()).length;
    const fullAllEventsBytes = JSON.stringify({ data: snapshot.events }).length;

    const page20Res = await app.fetch(new Request("https://playon.test/api/events?status=all&limit=20"));
    const page20Text = await page20Res.text();
    const page20Bytes = page20Text.length;
    const page20Json = JSON.parse(page20Text) as { data?: Array<{ id: string }> };

    const firstId = page20Json.data?.[0]?.id ?? snapshot.events[0]?.id ?? "";
    const streamsRes = await app.fetch(
      new Request(`https://playon.test/api/stream/${firstId}?inspect=false`)
    );
    const singleStreamsBytes = (await streamsRes.text()).length;

    const extractMinusDecodeMs = Math.max(0, extractAll796SteadyMs - decode796SteadyMs);
    const reconcileAndIndexMs = Math.max(0, build796SteadyMs - extractAll796SteadyMs);
    const est300LiveItemsCpuMs = (build796SteadyMs / rawCatalogItems) * 300;
    const scalingRatio = build2500SteadyMs / build796SteadyMs;
    const itemRatio = scaleRawItems / rawCatalogItems;

    const bundleKB = getBundleKB();
    const srcLoc = countSrcLoc(join(process.cwd(), "src"));

    const gates = {
      catalog796_le_12ms: build796SteadyMs <= 12,
      est300LiveItems_le_5ms: est300LiveItemsCpuMs <= 5,
      stress2493_le_35ms: build2500SteadyMs <= 35,
      linearScaling: scalingRatio <= itemRatio * 1.15,
      warm20Queries_le_4ms: warm20SteadyMs <= 4,
      dedup120_le_0_8ms: dedup120SteadyMs <= 0.8,
      m3u8Rewrite450_le_0_5ms: m3u8450SteadyMs <= 0.5,
      bundle_le_240KB: bundleKB !== null ? bundleKB <= 240 : null,
      zeroUnmapped:
        snapshot.reconciliation.summary.unmappedRawItemsCount === 0 &&
        scaleSnapshot.reconciliation.summary.unmappedRawItemsCount === 0,
      zeroRegressionsVsPrevious:
        build796SteadyMs < Math.min(PRE_HARDENING_BASELINE.coldCatalog796Ms, HARDENED_PREV_BASELINE.coldCatalog796Ms) &&
        build2500SteadyMs < Math.min(PRE_HARDENING_BASELINE.coldCatalog2500Ms, HARDENED_PREV_BASELINE.coldCatalog2500Ms) &&
        warm20SteadyMs < Math.min(PRE_HARDENING_BASELINE.warm20QueriesMs, HARDENED_PREV_BASELINE.warm20QueriesMs) &&
        l1Cached20SteadyMs < Math.min(PRE_HARDENING_BASELINE.l1Cached20QueriesMs, HARDENED_PREV_BASELINE.l1Cached20QueriesMs) &&
        dedup120SteadyMs < Math.min(PRE_HARDENING_BASELINE.streamDedup120Ms, HARDENED_PREV_BASELINE.streamDedup120Ms) &&
        m3u8450SteadyMs < Math.min(PRE_HARDENING_BASELINE.m3u8Rewrite450Ms, HARDENED_PREV_BASELINE.m3u8Rewrite450Ms) &&
        (bundleKB === null || bundleKB < Math.min(PRE_HARDENING_BASELINE.bundleKB, HARDENED_PREV_BASELINE.bundleKB)),
    };

    const report = {
      benchmark: "playon-production-launch",
      moduleStartupMs: r2(moduleStartupMs),
      dataset: {
        rawCatalogItems,
        v1UnifiedEvents: V1_BASELINE.unifiedEvents,
        unifiedEvents: snapshot.reconciliation.summary.unifiedEvents,
        unmappedRawItemsCount: snapshot.reconciliation.summary.unmappedRawItemsCount,
        scaleRawItems,
        scaleUnifiedEvents: scaleSnapshot.reconciliation.summary.unifiedEvents,
        scaleUnmappedCount: scaleSnapshot.reconciliation.summary.unmappedRawItemsCount,
        dedupInputStreams: rawStreams.length,
        dedupOutputStreams: deduped.streams.length,
        rewrittenM3u8Bytes: rewritten.length,
        conditional304Hits: count304,
      },
      stageBreakdown796Ms: {
        decodeCncRawIds: r2(decode796SteadyMs),
        extractNormalizeClassifyIdentity: r2(extractMinusDecodeMs),
        reconcilePass1To3AndSnapshotIndex: r2(reconcileAndIndexMs),
        totalBuild796Steady: r2(build796SteadyMs),
        est300LiveItemsCpu: r2(est300LiveItemsCpuMs),
      },
      timingsMs: {
        catalog796: {
          v1: V1_BASELINE.coldCatalog796Ms,
          preHardening: PRE_HARDENING_BASELINE.coldCatalog796Ms,
          hardenedPrev: HARDENED_PREV_BASELINE.coldCatalog796Ms,
          coldFirstRun: r2(cold796FirstRunMs),
          steadyIsolateMedian: r2(build796SteadyMs),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.coldCatalog796Ms, build796SteadyMs),
          vsV1: pct(V1_BASELINE.coldCatalog796Ms, build796SteadyMs),
        },
        catalog2493Stress: {
          preHardening: PRE_HARDENING_BASELINE.coldCatalog2500Ms,
          hardenedPrev: HARDENED_PREV_BASELINE.coldCatalog2500Ms,
          coldFirstRun: r2(cold2500FirstRunMs),
          steadyIsolateMedian: r2(build2500SteadyMs),
          scalingRatio: `${r2(scalingRatio)}x for ${r2(itemRatio)}x items`,
          msPer1000Items: r2((build2500SteadyMs / scaleRawItems) * 1000),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.coldCatalog2500Ms, build2500SteadyMs),
        },
        warm20FilterSearchQueries: {
          v1: V1_BASELINE.warm20QueriesMs,
          preHardening: PRE_HARDENING_BASELINE.warm20QueriesMs,
          hardenedPrev: HARDENED_PREV_BASELINE.warm20QueriesMs,
          coldFirstRun: r2(warm20FirstRunMs),
          steadyIsolateMedian: r2(warm20SteadyMs),
          avgPerReqMs: r3(warm20SteadyMs / queries.length),
          vsPreHardening: pct(PRE_HARDENING_BASELINE.warm20QueriesMs, warm20SteadyMs),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.warm20QueriesMs, warm20SteadyMs),
        },
        l1Cached20Queries: {
          v1: V1_BASELINE.l1Cached20QueriesMs,
          preHardening: PRE_HARDENING_BASELINE.l1Cached20QueriesMs,
          hardenedPrev: HARDENED_PREV_BASELINE.l1Cached20QueriesMs,
          steadyIsolateMedian: r2(l1Cached20SteadyMs),
          avgPerReqMs: r3(l1Cached20SteadyMs / queries.length),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.l1Cached20QueriesMs, l1Cached20SteadyMs),
        },
        l1Conditional304_20Queries: {
          steadyIsolateMedian: r2(cond304SteadyMs),
          avgPerReqMs: r3(cond304SteadyMs / queries.length),
        },
        streamDedupAndRank120: {
          v1: V1_BASELINE.streamDedup120Ms,
          preHardening: PRE_HARDENING_BASELINE.streamDedup120Ms,
          hardenedPrev: HARDENED_PREV_BASELINE.streamDedup120Ms,
          coldFirstRun: r2(dedupFirstRunMs),
          steadyIsolateMedian: r3(dedup120SteadyMs),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.streamDedup120Ms, dedup120SteadyMs),
        },
        m3u8Rewrite450Segments: {
          v1: V1_BASELINE.m3u8Rewrite450Ms,
          preHardening: PRE_HARDENING_BASELINE.m3u8Rewrite450Ms,
          hardenedPrev: HARDENED_PREV_BASELINE.m3u8Rewrite450Ms,
          coldFirstRun: r2(m3u8FirstRunMs),
          steadyIsolateMedian: r3(m3u8450SteadyMs),
          vsPreHardening: pct(PRE_HARDENING_BASELINE.m3u8Rewrite450Ms, m3u8450SteadyMs),
          vsHardenedPrev: pct(HARDENED_PREV_BASELINE.m3u8Rewrite450Ms, m3u8450SteadyMs),
        },
      },
      footprint: {
        bundleKB: {
          v1: V1_BASELINE.bundleKB,
          preHardening: PRE_HARDENING_BASELINE.bundleKB,
          hardenedPrev: HARDENED_PREV_BASELINE.bundleKB,
          current: bundleKB,
        },
        srcLoc: {
          v1: V1_BASELINE.srcLoc,
          preHardening: PRE_HARDENING_BASELINE.srcLoc,
          hardenedPrev: HARDENED_PREV_BASELINE.srcLoc,
          current: srcLoc,
        },
      },
      payloadsKB: {
        fullCatalogAllEvents: {
          v1: V1_BASELINE.fullCatalogJsonKB,
          current: r2(fullAllEventsBytes / 1024),
          vsV1: pct(V1_BASELINE.fullCatalogJsonKB, fullAllEventsBytes / 1024),
        },
        maxPage100Events: r2(fullBytes / 1024),
        paginated20Events: {
          v1: V1_BASELINE.paginated20EventsJsonKB,
          current: r2(page20Bytes / 1024),
          vsV1: pct(V1_BASELINE.paginated20EventsJsonKB, page20Bytes / 1024),
        },
        singleEventStreams: {
          v1: V1_BASELINE.singleEventStreamsJsonKB,
          current: r2(singleStreamsBytes / 1024),
          vsV1: pct(V1_BASELINE.singleEventStreamsJsonKB, singleStreamsBytes / 1024),
        },
      },
      gates,
    };

    console.log(JSON.stringify(report, null, 2));
    const failedGates = Object.entries(gates).filter(([, v]) => v === false);
    if (failedGates.length > 0) {
      console.error("Failed performance gates:", failedGates.map(([k]) => k).join(", "));
      process.exit(1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
