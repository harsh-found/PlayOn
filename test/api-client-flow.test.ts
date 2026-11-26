import { afterEach, describe, expect, it, vi } from "vitest";
import { generateHeavyCatalogByProvider, generateHeavyRawStreams } from "../scripts/bench-fixtures";
import { API_ROUTE_PATHS, isOpenApiMaterialized, resetOpenApiCache } from "../src/docs/openapi";
import { createApp } from "../src/index";

const FIXED_NOW = Date.parse("2026-11-24T12:00:00.000Z");

function installMockUpstream() {
  const catalog = generateHeavyCatalogByProvider(FIXED_NOW);
  const streams = generateHeavyRawStreams().slice(0, 24);
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/catalog/tv/")) {
      const m = /\/catalog\/tv\/([^.]+)\.json/.exec(url);
      const id = m && m[1] ? decodeURIComponent(m[1]) : "";
      return new Response(JSON.stringify({ metas: catalog.get(id) ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/stream/tv/")) {
      return new Response(JSON.stringify({ streams }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("master") && url.includes(".m3u8")) {
      return new Response(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080,FRAME-RATE=50\n1080p.m3u8\n",
        { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
  return spy;
}

describe("PlayOn End-to-End API Client Flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenApiCache();
  });

  it("supports the complete discovery -> events -> detail+streams -> streams -> proxy journey", async () => {
    installMockUpstream();
    const { app } = createApp();

    // 1. Root manifest
    const rootRes = await app.fetch(new Request("https://api.playon.dev/"));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("X-PlayOn-Version")).toBe("1.0.1");
    expect(rootRes.headers.get("Server-Timing")).toMatch(/^total;dur=/);
    expect(rootRes.headers.get("Vary")).toBe("Accept-Encoding");
    expect(rootRes.headers.get("X-Request-Id")).toBeTruthy();
    const manifest = (await rootRes.json()) as { data: { service: string; version: string; links: Record<string, string> }; meta: { stale: boolean; generatedAt: string } };
    expect(manifest.data.service).toBe("PlayOn");
    expect(manifest.data.version).toBe("1.0.1");
    expect(manifest.data.links.facets).toBe("/api/facets");
    expect(manifest.data.links.stream).toBe("/api/stream/{id}");
    expect(manifest.meta.stale).toBe(false);

    // 2. Discovery facets
    const facetsRes = await app.fetch(new Request("https://api.playon.dev/api/facets"));
    expect(facetsRes.status).toBe(200);
    const facetsBody = (await facetsRes.json()) as {
      data: {
        counts: { live: number; upcoming: number; ended: number; active: number };
        sports: Array<{ id: string; label: string; total: number }>;
        competitions: Array<{ id: string }>;
        teams: Array<{ id: string }>;
        broadcasters: Array<{ id: string }>;
      };
      meta: { stale: boolean; generatedAt: string };
    };
    expect(facetsBody.data.sports.length).toBeGreaterThanOrEqual(7);
    expect(facetsBody.data.competitions.length).toBeGreaterThan(0);
    expect(facetsBody.data.teams.length).toBeGreaterThan(0);
    expect(facetsBody.data.broadcasters.length).toBeGreaterThan(0);
    expect(facetsBody.meta.stale).toBe(false);

    // 3. Events feed using facet sport alias + composable filters
    const eventsRes = await app.fetch(
      new Request("https://api.playon.dev/api/events?sport=soccer&status=all&limit=10&sort=popularity")
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      data: Array<{
        id: string;
        sport: string;
        streamsUrl: string;
        debug?: unknown;
      }>;
      meta: { total: number; returned: number; limit: number; offset: number };
    };
    expect(eventsBody.data.length).toBeGreaterThan(0);
    expect(eventsBody.data.every((e) => e.sport === "football")).toBe(true);
    expect(eventsBody.data.every((e) => e.streamsUrl === `/api/stream/${e.id}`)).toBe(true);
    // Lean by default: zero debug/providerPointers leak
    expect(eventsBody.data.every((e) => e.debug === undefined)).toBe(true);

    // Opt-in ?include=debug exposes provenance cleanly
    const debugRes = await app.fetch(
      new Request("https://api.playon.dev/api/events?sport=cricket&status=all&limit=2&include=debug")
    );
    const debugBody = (await debugRes.json()) as {
      data: Array<{ debug?: { canonicalKey: string; providerRawIds: Record<string, string[]> } }>;
    };
    expect(debugBody.data[0]?.debug?.canonicalKey).toBeTruthy();
    expect(Object.keys(debugBody.data[0]?.debug?.providerRawIds ?? {}).length).toBeGreaterThan(0);

    // 4. Single event detail WITH ranked streams in one round-trip
    const targetId = eventsBody.data[0]!.id;
    const detailRes = await app.fetch(
      new Request(`https://api.playon.dev/api/events/${targetId}?inspect=false`)
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: {
        id: string;
        streams?: Array<{ id: string; rank: number; score: number; proxyUrl: string; needsProxy: boolean }>;
        streamMeta?: { total: number; recommendedId: string | null };
      };
    };
    expect(detailBody.data.id).toBe(targetId);
    expect(detailBody.data.streams?.length).toBeGreaterThan(0);
    expect(detailBody.data.streams?.[0]?.rank).toBe(1);
    expect(detailBody.data.streams?.[0]?.proxyUrl).toContain("/api/proxy?url=");
    expect(detailBody.data.streamMeta?.recommendedId).toBe(detailBody.data.streams?.[0]?.id ?? detailBody.data.streamMeta?.recommendedId);

    // Detail without streams (?streams=false)
    const noStreamsRes = await app.fetch(
      new Request(`https://api.playon.dev/api/events/${targetId}?streams=false`)
    );
    const noStreamsBody = (await noStreamsRes.json()) as { data: { streams?: unknown } };
    expect(noStreamsBody.data.streams).toBeUndefined();

    // 5. Lightweight streams refresh with language filter via /api/stream/:id
    const streamsRes = await app.fetch(
      new Request(`https://api.playon.dev/api/stream/${targetId}?language=hin&inspect=false`)
    );
    expect(streamsRes.status).toBe(200);
    const streamsBody = (await streamsRes.json()) as {
      data: { streams: Array<{ language: string }>; filters: { languages: string[] } };
    };
    expect(streamsBody.data.streams.length).toBeGreaterThan(0);
    expect(streamsBody.data.streams.every((s) => s.language === "hin")).toBe(true);
  });

  it("supports ETag / 304 Not Modified, HEAD, and CORS OPTIONS preflight", async () => {
    installMockUpstream();
    const { app } = createApp();

    const first = await app.fetch(new Request("https://api.playon.dev/api/events?status=all&limit=5"));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^W\/"/);

    // Warm L1 hit
    const second = await app.fetch(new Request("https://api.playon.dev/api/events?status=all&limit=5"));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT-L1");

    // Conditional 304
    const notMod = await app.fetch(
      new Request("https://api.playon.dev/api/events?status=all&limit=5", {
        headers: { "If-None-Match": etag! },
      })
    );
    expect(notMod.status).toBe(304);
    expect(await notMod.text()).toBe("");

    // HEAD request returns empty body with headers
    const head = await app.fetch(
      new Request("https://api.playon.dev/api/events?status=all&limit=5", { method: "HEAD" })
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(etag);
    expect(await head.text()).toBe("");

    // OPTIONS preflight
    const opt = await app.fetch(new Request("https://api.playon.dev/api/events", { method: "OPTIONS" }));
    expect(opt.status).toBe(204);
    expect(opt.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns RFC 9457 Problem Details for invalid queries, missing events, and unknown routes", async () => {
    installMockUpstream();
    const { app } = createApp();

    const badSort = await app.fetch(new Request("https://api.playon.dev/api/events?sort=chaos"));
    expect(badSort.status).toBe(400);
    expect(badSort.headers.get("Content-Type")).toContain("application/problem+json");
    const p1 = (await badSort.json()) as { status: number; code: string };
    expect(p1.status).toBe(400);
    expect(p1.code).toBe("INVALID_QUERY");

    const hugeQ = await app.fetch(new Request(`https://api.playon.dev/api/events?q=${"a".repeat(121)}`));
    expect(hugeQ.status).toBe(400);

    const missingEvent = await app.fetch(new Request("https://api.playon.dev/api/events/evt_doesnotexist"));
    expect(missingEvent.status).toBe(404);
    expect(missingEvent.headers.get("Content-Type")).toContain("application/problem+json");

    const unknownRoute = await app.fetch(new Request("https://api.playon.dev/v1/legacy-route"));
    expect(unknownRoute.status).toBe(404);
    const p404 = (await unknownRoute.json()) as { code: string };
    expect(p404.code).toBe("ROUTE_NOT_FOUND");
  });

  it("lazily generates OpenAPI 3.1.0 locked 1:1 to all 9 /api/* routes", async () => {
    installMockUpstream();
    resetOpenApiCache();
    const { app } = createApp();

    // Hot path traffic MUST NOT trigger OpenAPI construction
    await app.fetch(new Request("https://api.playon.dev/"));
    await app.fetch(new Request("https://api.playon.dev/api/events?limit=5"));
    expect(isOpenApiMaterialized()).toBe(false);

    const specRes = await app.fetch(new Request("https://api.playon.dev/api/openapi.json"));
    expect(specRes.status).toBe(200);
    expect(isOpenApiMaterialized()).toBe(true);
    const spec = (await specRes.json()) as { openapi: string; info: { title: string; version: string }; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toContain("PlayOn");
    expect(Object.keys(spec.paths).sort()).toEqual([...API_ROUTE_PATHS].sort());
    expect(Object.keys(spec.paths).length).toBe(9);

    const etag = specRes.headers.get("ETag")!;
    const spec304 = await app.fetch(
      new Request("https://api.playon.dev/api/openapi.json", { headers: { "If-None-Match": etag } })
    );
    expect(spec304.status).toBe(304);
  });

  it("exposes health and zero-loss telemetry/metrics endpoints with Cache-Control: no-store", async () => {
    installMockUpstream();
    const { app } = createApp();

    const healthRes = await app.fetch(new Request("https://api.playon.dev/api/health"));
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("Cache-Control")).toBe("no-store");
    const health = (await healthRes.json()) as { data: { status: string; providers: { healthy: number } } };
    expect(health.data.status).toBe("ok");
    expect(health.data.providers.healthy).toBe(6);

    const metricsRes = await app.fetch(new Request("https://api.playon.dev/api/metrics?detail=full"));
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers.get("Cache-Control")).toBe("no-store");
    const metrics = (await metricsRes.json()) as {
      data: { reconciliation: { summary: { unmappedRawItemsCount: number; status: string }; mergeDecisions: unknown[] } };
    };
    expect(metrics.data.reconciliation.summary.unmappedRawItemsCount).toBe(0);
    expect(metrics.data.reconciliation.summary.status).toBe("verified_zero_loss");
    expect(Array.isArray(metrics.data.reconciliation.mergeDecisions)).toBe(true);
  });

  it("exposes rich client-ready metadata with deterministic ETags and isolates cache keys across debug/streams/inspect flags", async () => {
    installMockUpstream();
    const { app } = createApp();

    const r1 = await app.fetch(new Request("https://api.playon.dev/api/events?status=all&limit=5"));
    const r2 = await app.fetch(new Request("https://api.playon.dev/api/events?status=all&limit=5"));
    expect(r1.headers.get("ETag")).toBe(r2.headers.get("ETag"));

    const body = (await r1.json()) as {
      data: Array<{
        id: string;
        streamCount: number;
        maxQuality: string | null;
        hasDrmFree: boolean;
        hasWebPlayable: boolean;
        broadcasters: string[];
        languages: string[];
        debug?: unknown;
      }>;
    };
    const ev = body.data[0]!;
    expect(typeof ev.streamCount).toBe("number");
    expect(typeof ev.hasDrmFree).toBe("boolean");
    expect(typeof ev.hasWebPlayable).toBe("boolean");
    expect(Array.isArray(ev.broadcasters)).toBe(true);
    expect(Array.isArray(ev.languages)).toBe(true);
    expect(ev.debug).toBeUndefined();

    // Cache-key isolation: ?include=debug must NOT serve the cached lean response
    const debugRes = await app.fetch(
      new Request("https://api.playon.dev/api/events?status=all&limit=5&include=debug")
    );
    const debugBody = (await debugRes.json()) as { data: Array<{ debug?: { canonicalKey: string } }> };
    expect(debugBody.data[0]?.debug?.canonicalKey).toBeTruthy();

    // Cache-key isolation on event detail: ?streams=false vs default ?streams=true
    const withStreams = await app.fetch(new Request(`https://api.playon.dev/api/events/${ev.id}?inspect=false`));
    const withoutStreams = await app.fetch(
      new Request(`https://api.playon.dev/api/events/${ev.id}?streams=false&inspect=false`)
    );
    const wsBody = (await withStreams.json()) as { data: { streams?: unknown[]; streamCount: number; maxQuality: string | null } };
    const wosBody = (await withoutStreams.json()) as { data: { streams?: unknown[] } };
    expect(wsBody.data.streams?.length).toBeGreaterThan(0);
    expect(wsBody.data.streamCount).toBe(wsBody.data.streams?.length);
    expect(wsBody.data.maxQuality).toBeTruthy();
    expect(wosBody.data.streams).toBeUndefined();
  });
});
