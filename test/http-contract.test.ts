import { afterEach, describe, expect, it } from "vitest";
import { EdgeTelemetry } from "../src/edge/telemetry";
import { API_ROUTE_PATHS, isOpenApiMaterialized, resetOpenApiCache } from "../src/docs/openapi";
import { createApp } from "../src/index";
import type { UpstreamMeta } from "../src/types";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function encodeMeta(provider: string, payload: Record<string, unknown>): UpstreamMeta {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(`${provider}:${JSON.stringify(payload)}`)));
  return { id: `cnc:${b64}`, type: "tv", name: String(payload.title ?? "") };
}

function installMockUpstreams(nowIso: string) {
  const nowMs = Date.parse(nowIso);
  const liveStart = new Date(nowMs - 20 * 60_000).toISOString();
  const upcomingStart = new Date(nowMs + 3 * 3600_000).toISOString();
  const endedStart = new Date(nowMs - 10 * 3600_000).toISOString();

  const items = [
    encodeMeta("sportzx", {
      title: "India vs Australia",
      eventInfo: { eventCat: "Cricket", eventName: "ICC T20 World Cup", teamA: "India", teamB: "Australia", startTime: liveStart, isLive: true, isHot: true },
      formats: [{ title: "Star Sports 1 Hindi 1080p", webLink: "https://cdn.example.net/hin.m3u8" }],
    }),
    encodeMeta("sportzx", {
      title: "Arsenal vs Chelsea",
      eventInfo: { eventCat: "Football", eventName: "Premier League", teamA: "Arsenal", teamB: "Chelsea", startTime: upcomingStart },
      formats: [{ title: "Sky Sports Main Event 720p", webLink: "https://cdn.example.net/sky.m3u8" }],
    }),
    encodeMeta("sportzx", {
      title: "Lakers vs Celtics",
      eventInfo: { eventCat: "Basketball", eventName: "NBA", teamA: "Lakers", teamB: "Celtics", startTime: endedStart, isEnded: true },
    }),
  ];

  const streams = [
    { url: "https://slivcdn.com/live/ss1-hin/master.m3u8", name: "Star Sports 1 Hindi 1080p", title: "Star Sports 1 Hindi 1080p" },
    { url: "https://cdn.example.net/dash/eng/manifest.mpd", name: "Sky Sports Cricket 720p", title: "Sky Sports Cricket 720p", clearkey: "0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210" },
    { url: "https://cdn.example.net/wv/manifest.mpd", name: "Widevine 1080p", title: "Widevine L3 Feed" },
  ];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/catalog/tv/")) {
      return new Response(JSON.stringify({ metas: url.includes("SportzX") ? items : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/stream/tv/")) {
      return new Response(JSON.stringify({ streams }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("HTTP API Contract, Validation, OpenAPI & EdgeTelemetry", () => {
  it("serves service manifest on / with uniform envelope and responds to OPTIONS CORS preflight with 204", async () => {
    const { app } = createApp();
    const opt = await app.fetch(new Request("https://playon.test/api/events", { method: "OPTIONS" }));
    expect(opt.status).toBe(204);
    expect(opt.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(opt.headers.get("Access-Control-Max-Age")).toBe("86400");

    const res = await app.fetch(new Request("https://playon.test/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { service: string; providers: unknown[]; links: Record<string, string> }; meta: { stale: boolean; generatedAt: string } };
    expect(body.data.service).toBe("PlayOn");
    expect(body.data.providers).toHaveLength(6);
    expect(body.data.links.openapi).toBe("/api/openapi.json");
    expect(body.data.links.stream).toBe("/api/stream/{id}");
    expect(body.meta.stale).toBe(false);
  });

  it("supports HEAD with empty body and rejects non-GET/HEAD methods with 405 Method Not Allowed and Allow header", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();
    const head = await app.fetch(new Request("https://playon.test/api/events", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("ETag")).toBeTruthy();

    const post = await app.fetch(new Request("https://playon.test/api/events", { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(post.headers.get("Content-Type")).toContain("application/problem+json");
    expect((await post.json() as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("validates query parameters strictly and returns RFC 9457 400 errors on invalid inputs", async () => {
    const { app } = createApp();
    const badUrls = [
      "/api/events?status=bogus",
      "/api/events?limit=0",
      "/api/events?limit=999",
      "/api/events?date=25-11-2026",
      `/api/events?q=${"a".repeat(121)}`,
      `/api/facets?q=${"b".repeat(121)}`,
      "/api/facets?status=invalid",
      "/api/stream/evt_123?protocol=rtmp",
      "/api/stream/%E0%A4%A",
    ];
    for (const path of badUrls) {
      const res = await app.fetch(new Request(`https://playon.test${path}`));
      expect(res.status, path).toBe(400);
      expect(res.headers.get("Content-Type"), path).toContain("application/problem+json");
    }
  });

  it("filters /api/events across status, sport, hot, q, sort, page/offset pagination, and include=debug", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();

    const active = (await (await app.fetch(new Request("https://playon.test/api/events"))).json()) as { data: Array<{ status: string }>; meta: { total: number } };
    expect(active.meta.total).toBe(2);
    expect(active.data.every((e) => e.status !== "ended")).toBe(true);

    const allSorted = (await (await app.fetch(new Request("https://playon.test/api/events?status=all&sort=title&limit=2&page=2"))).json()) as {
      data: Array<{ title: string }>;
      meta: { total: number; offset: number; returned: number; hasMore: boolean };
    };
    expect(allSorted.meta.total).toBe(3);
    expect(allSorted.meta.offset).toBe(2);
    expect(allSorted.meta.returned).toBe(1);
    expect(allSorted.meta.hasMore).toBe(false);

    const dbg = (await (await app.fetch(new Request("https://playon.test/api/events?sport=cricket&include=debug"))).json()) as {
      data: Array<{ debug?: { canonicalKey: string } }>;
    };
    expect(dbg.data[0]?.debug?.canonicalKey).toContain("cricket::");
  });

  it("filters /api/facets dynamically by sport, status, and search q", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();

    const globalFacets = (await (await app.fetch(new Request("https://playon.test/api/facets"))).json()) as {
      data: { counts: { live: number; upcoming: number; ended: number } };
    };
    expect(globalFacets.data.counts).toEqual({ live: 1, upcoming: 1, ended: 1, active: 2 });

    const cricketFacets = (await (await app.fetch(new Request("https://playon.test/api/facets?sport=cricket&status=live"))).json()) as {
      data: { sports: Array<{ id: string; total: number }> };
    };
    expect(cricketFacets.data.sports).toHaveLength(1);
    expect(cricketFacets.data.sports[0]?.id).toBe("cricket");
  });

  it("supports /api/events/:id with streams=false vs streams=true and returns 404 for unknown event IDs", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();

    const list = (await (await app.fetch(new Request("https://playon.test/api/events?sport=cricket"))).json()) as { data: Array<{ id: string }> };
    const id = list.data[0]!.id;

    const noStreams = (await (await app.fetch(new Request(`https://playon.test/api/events/${id}?streams=false`))).json()) as {
      data: { streams?: unknown };
    };
    expect(noStreams.data.streams).toBeUndefined();

    const withStreams = (await (await app.fetch(new Request(`https://playon.test/api/events/${id}?inspect=false`))).json()) as {
      data: { streams?: unknown[]; streamMeta?: { total: number } };
    };
    expect(withStreams.data.streams).toHaveLength(3);
    expect(withStreams.data.streamMeta?.total).toBe(3);

    const missing = await app.fetch(new Request("https://playon.test/api/events/evt_does_not_exist"));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe("EVENT_NOT_FOUND");
  });

  it("filters /api/stream/:id by language, protocol, drmFree, webPlayable, broadcaster, and include=debug", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();
    const list = (await (await app.fetch(new Request("https://playon.test/api/events?sport=cricket"))).json()) as { data: Array<{ id: string }> };
    const id = list.data[0]!.id;

    const drmFree = (await (await app.fetch(new Request(`https://playon.test/api/stream/${id}?inspect=false&drmFree=true`))).json()) as {
      data: { streams: Array<{ drm: unknown; language: string }> };
    };
    expect(drmFree.data.streams).toHaveLength(1);
    expect(drmFree.data.streams[0]?.language).toBe("hin");

    const webOnly = (await (await app.fetch(new Request(`https://playon.test/api/stream/${id}?inspect=false&webPlayable=true&include=debug`))).json()) as {
      data: { streams: Array<{ webPlayable: boolean }>; debug?: { providers: unknown[] } };
    };
    expect(webOnly.data.streams).toHaveLength(2);
    expect(webOnly.data.streams.every((s) => s.webPlayable)).toBe(true);
    expect(webOnly.data.debug?.providers.length).toBeGreaterThan(0);
  });

  it("reports healthy 200 and degraded 503 accurately on /api/health", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();
    const okRes = await app.fetch(new Request("https://playon.test/api/health"));
    expect(okRes.status).toBe(200);
    expect((await okRes.json() as { data: { status: string } }).data.status).toBe("ok");

    globalThis.fetch = (async () => new Response("Down", { status: 503 })) as typeof fetch;
    const { app: downApp } = createApp();
    const badRes = await downApp.fetch(new Request("https://playon.test/api/health"));
    expect(badRes.status).toBe(503);
    expect((await badRes.json() as { data: { status: string } }).data.status).toBe("degraded");
  });

  it("exposes concise reconciliation summary on /api/metrics and full arrays on /api/metrics?detail=full", async () => {
    installMockUpstreams(new Date().toISOString());
    const { app } = createApp();

    const concise = (await (await app.fetch(new Request("https://playon.test/api/metrics"))).json()) as {
      data: { reconciliation: { summary: unknown; mergeDecisions?: unknown } };
    };
    expect(concise.data.reconciliation.summary).toBeDefined();
    expect(concise.data.reconciliation.mergeDecisions).toBeUndefined();

    const full = (await (await app.fetch(new Request("https://playon.test/api/metrics?detail=full"))).json()) as {
      data: { reconciliation: { mergeDecisions?: unknown[]; preventedMerges?: unknown[] } };
    };
    expect(Array.isArray(full.data.reconciliation.mergeDecisions)).toBe(true);
    expect(Array.isArray(full.data.reconciliation.preventedMerges)).toBe(true);
  });

  it("materializes /api/openapi.json lazily, documents all 9 routes, and serves 304 Not Modified on matching ETag", async () => {
    resetOpenApiCache();
    expect(isOpenApiMaterialized()).toBe(false);
    const { app } = createApp();

    const res = await app.fetch(new Request("https://playon.test/api/openapi.json"));
    expect(res.status).toBe(200);
    expect(isOpenApiMaterialized()).toBe(true);
    const etag = res.headers.get("ETag") ?? "";
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual([...API_ROUTE_PATHS].sort());

    const r304 = await app.fetch(new Request("https://playon.test/api/openapi.json", { headers: { "If-None-Match": etag } }));
    expect(r304.status).toBe(304);
  });

  it("bounds EdgeTelemetry ring buffer to 256 samples and buckets 404 scanner paths under /* (unmatched)", () => {
    const tel = new EdgeTelemetry();
    for (let i = 1; i <= 300; i++) tel.record("/api/events", 200, i);
    for (let i = 0; i < 50; i++) tel.record(`/wp-login-${i}.php`, 404, 1);
    tel.record("/api/events", 503, 12);
    tel.record("/api/stream/evt_abc", 200, 5);

    const snap = tel.snapshot();
    expect(snap.totalRequests).toBe(352);
    expect(snap.totalErrors).toBe(1);
    expect(Object.keys(snap.routes)).toEqual(["/* (unmatched)", "/api/events", "/api/stream/:id"]);
    expect(snap.routes["/* (unmatched)"]!.requests).toBe(50);
    // Ring keeps the last 256 samples -> p50 should be >= 170
    expect(snap.routes["/api/events"]!.p50Ms).toBeGreaterThanOrEqual(170);
  });

  it("returns 503 UPSTREAM_UNAVAILABLE on /api/events when all upstream hosts fail on cold start", async () => {
    globalThis.fetch = (async () => new Response("Down", { status: 503 })) as typeof fetch;
    const { app } = createApp();
    const res = await app.fetch(new Request("https://playon.test/api/events"));
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});
