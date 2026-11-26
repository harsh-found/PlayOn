import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHlsMasterPlaylist, rewriteM3u8Playlist } from "../src/domain/m3u8";
import { buildCatalogSnapshot } from "../src/domain/reconciliation";
import { extractUrlTokenExpiryMs, StreamEngine } from "../src/domain/streams";
import { RequestBudget } from "../src/edge/budget";
import { DeadStreamTracker } from "../src/edge/dead-streams";
import { signProxyPayload, verifySignedProxyParams } from "../src/edge/signing";
import { createApp } from "../src/index";
import type { UpstreamMeta, UpstreamStream, WorkerEnv } from "../src/types";

const NOW = Date.parse("2026-11-24T14:00:00.000Z");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function encodeRawId(prefix: string, payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}:${b64}`;
}

function makeProviderPayload(provider: string, items: UpstreamMeta[]) {
  return {
    provider,
    name: provider,
    items,
    rawCount: items.length,
    exclusions: [],
    healthy: true,
  };
}

describe("Production Hardening — Event ID Stability & Cold-Isolate Hydration", () => {
  it("keeps evt_* ID identical across provider add/drop, home/away reversal, cross-midnight shift, and cricket format churn", () => {
    const baseItemA: UpstreamMeta = {
      id: encodeRawId("fancode", {
        title: "India vs Australia",
        league: "Border Gavaskar T20 Series",
        startTime: "2026-11-24T23:55:00.000Z",
        status: "live",
        category: "cricket",
      }),
      name: "India vs Australia",
    };

    const reversedCrossMidnightOdi: UpstreamMeta = {
      id: encodeRawId("sliv", {
        title: "Australia vs India",
        league: "Border Gavaskar ODI Series",
        startTime: "2026-11-25T00:15:00.000Z",
        status: "live",
        category: "cricket",
      }),
      name: "Australia vs India",
    };

    const snapSingle = buildCatalogSnapshot([makeProviderPayload("fancode", [baseItemA])], NOW);
    const snapReversed = buildCatalogSnapshot([makeProviderPayload("sonyliv", [reversedCrossMidnightOdi])], NOW);
    const snapMerged = buildCatalogSnapshot(
      [
        makeProviderPayload("fancode", [baseItemA]),
        makeProviderPayload("sonyliv", [reversedCrossMidnightOdi]),
      ],
      NOW
    );

    expect(snapSingle.events).toHaveLength(1);
    expect(snapReversed.events).toHaveLength(1);
    expect(snapMerged.events).toHaveLength(1);

    const idSingle = snapSingle.events[0]?.id;
    const idReversed = snapReversed.events[0]?.id;
    const idMerged = snapMerged.events[0]?.id;

    expect(idSingle).toMatch(/^evt_[a-f0-9]{12}$/);
    expect(idSingle).toBe(idReversed);
    expect(idSingle).toBe(idMerged);
  });

  it("hydrates deep-linked /api/events/:id and /api/stream/:id on a completely cold Worker isolate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const item: UpstreamMeta = {
      id: encodeRawId("fancode", {
        title: "Arsenal vs Chelsea",
        league: "Premier League",
        startTime: "2026-11-24T14:00:00.000Z",
        status: "live",
        category: "football",
      }),
      name: "Arsenal vs Chelsea",
    };
    const expectedId = buildCatalogSnapshot([makeProviderPayload("sportzx", [item])], NOW).events[0]?.id;
    expect(expectedId).toBeTruthy();

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        return new Response(JSON.stringify({ metas: [item] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/catalog/tv/")) {
        return new Response(JSON.stringify({ metas: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/stream/tv/")) {
        return new Response(
          JSON.stringify({
            streams: [
              {
                name: "Sky Sports Main Event",
                title: "1080p English HLS",
                url: "https://cdn.example.com/epl/master.m3u8",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    // Cold isolate #1 directly hits /api/events/:id
    const cold1 = createApp();
    const detailRes = await cold1.app.fetch(
      new Request(`https://api.playon.dev/api/events/${expectedId}?inspect=false`)
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      data: { id: string; streamsUrl: string; streams: Array<{ proxyUrl: string }> };
    };
    expect(detailJson.data.id).toBe(expectedId);
    expect(detailJson.data.streamsUrl).toBe(`/api/stream/${expectedId}`);
    expect(detailJson.data.streams).toHaveLength(1);
    expect(detailJson.data.streams[0]?.proxyUrl).toContain("/api/proxy?url=");

    // Cold isolate #2 directly hits /api/stream/:id
    const cold2 = createApp();
    const streamRes = await cold2.app.fetch(
      new Request(`https://api.playon.dev/api/stream/${expectedId}?inspect=false`)
    );
    expect(streamRes.status).toBe(200);
    const streamJson = (await streamRes.json()) as {
      data: { eventId: string; streams: Array<{ broadcaster: string }> };
    };
    expect(streamJson.data.eventId).toBe(expectedId);
    expect(streamJson.data.streams).toHaveLength(1);
  });
});

describe("Production Hardening — Live-Derived Stream Dedup, Protocol Truth & Token Expiry", () => {
  it("collapses aiv-cdn.net Nitro regional PoPs while preserving distinct maxh resolution tiers", () => {
    const inputs: Array<{ provider: string; stream: UpstreamStream }> = [
      {
        provider: "fancode",
        stream: {
          name: "FanCode HD",
          title: "1080p",
          url: "https://d1234.aiv-cdn.net/iad-nitro/live/clients/dash/enc/abc/out/v1/stream.mpd?maxh=1080",
        },
      },
      {
        provider: "fancode",
        stream: {
          name: "FanCode HD",
          title: "1080p",
          url: "https://d5678.aiv-cdn.net/bom-nitro/live/clients/dash/enc/abc/out/v1/stream.mpd?maxh=1080",
        },
      },
      {
        provider: "fancode",
        stream: {
          name: "FanCode HD",
          title: "720p",
          url: "https://d5678.aiv-cdn.net/sin-nitro/live/clients/dash/enc/abc/out/v1/stream.mpd?maxh=720",
        },
      },
    ];

    const res = StreamEngine.deduplicateAndRank(inputs, "https://api.playon.dev");
    expect(res.streams).toHaveLength(2);
    const heights = res.streams.map((s) => s.height ?? 0).sort((a, b) => b - a);
    expect(heights).toEqual([1080, 720]);
  });

  it("collapses pure ABR playlists carrying conflicting marketing quality labels (1080p vs Auto vs 480p)", () => {
    const inputs: Array<{ provider: string; stream: UpstreamStream }> = [
      {
        provider: "sonyliv",
        stream: { name: "Sony Sports Ten 1", title: "1080p English", url: "https://cdn.sonyliv.com/live/main.m3u8" },
      },
      {
        provider: "sonyliv",
        stream: { name: "Sony Sports Ten 1", title: "Auto English", url: "https://cdn.sonyliv.com/live/main.m3u8" },
      },
      {
        provider: "sonyliv",
        stream: { name: "Sony Sports Ten 1", title: "480p English", url: "https://cdn.sonyliv.com/live/main.m3u8" },
      },
    ];

    const res = StreamEngine.deduplicateAndRank(inputs, "https://api.playon.dev");
    expect(res.streams).toHaveLength(1);
  });

  it("collapses generic broadcaster into named broadcaster on identical URL but preserves 2 distinct named broadcasters", () => {
    const identicalUrl = "https://cdn.example.com/ch1/master.m3u8";
    const genericVsNamed = StreamEngine.deduplicateAndRank(
      [
        { provider: "cricfy", stream: { name: "HD 1", title: "1080p", url: identicalUrl } },
        { provider: "sonyliv", stream: { name: "Sony Sports Ten 2", title: "1080p", url: identicalUrl } },
      ],
      "https://api.playon.dev"
    );
    expect(genericVsNamed.streams).toHaveLength(1);
    expect(genericVsNamed.streams[0]?.broadcaster).toContain("Sony Sports");

    const twoDistinctNamed = StreamEngine.deduplicateAndRank(
      [
        { provider: "fancode", stream: { name: "Sky Sports Main Event", title: "1080p", url: identicalUrl } },
        { provider: "cricfy", stream: { name: "TNT Sports 1", title: "1080p", url: identicalUrl } },
      ],
      "https://api.playon.dev"
    );
    expect(twoDistinctNamed.streams).toHaveLength(2);
  });

  it("detects HLS and DASH protocols on bridged wrapper URLs and extracts token expiry timestamps", () => {
    const bridgedHls =
      "https://bridge.example.com/proxy?d=" +
      encodeURIComponent("https://origin.cdn.com/live/stream.m3u8?hdnea=st=1795660000~exp=1795670807~acl=/*~hmac=abc");
    const bridgedDash =
      "https://bridge.example.com/proxy?url=" +
      encodeURIComponent("https://origin.cdn.com/live/manifest.mpd?expires=1795671000");

    const res = StreamEngine.deduplicateAndRank(
      [
        { provider: "cricfy", stream: { name: "Paramount+", title: "1080p", url: bridgedHls } },
        { provider: "sonyliv", stream: { name: "Sony Sports Ten 1", title: "1080p", url: bridgedDash } },
      ],
      "https://api.playon.dev"
    );

    const hlsStream = res.streams.find((s) => s.url === bridgedHls);
    const dashStream = res.streams.find((s) => s.url === bridgedDash);
    expect(hlsStream?.protocol).toBe("hls");
    expect(hlsStream?.broadcaster).toBe("Paramount+");
    expect(dashStream?.protocol).toBe("dash");

    expect(extractUrlTokenExpiryMs(bridgedHls)).toBe(1795670807 * 1000);
    expect(extractUrlTokenExpiryMs(bridgedDash)).toBe(1795671000 * 1000);
    expect(extractUrlTokenExpiryMs("https://cdn.example.com/live.m3u8?exp=1795672000")).toBe(1795672000 * 1000);
  });

  it("demotes dead streams by -35 score and restores them upon recovery", () => {
    const tracker = new DeadStreamTracker();
    const deadUrl = "https://cdn.example.com/dead/master.m3u8?token=abc123";
    const healthyUrl = "https://cdn.example.com/healthy/master.m3u8?token=xyz999";

    tracker.recordFailure(deadUrl, NOW);
    expect(tracker.isDemoted(deadUrl, NOW + 10_000)).toBe(true);
    // Token rotation on the same path still matches the dead tracking key
    expect(tracker.isDemoted("https://cdn.example.com/dead/master.m3u8?token=rotated", NOW + 10_000)).toBe(true);

    const rankedHealthy = StreamEngine.deduplicateAndRank(
      [{ provider: "fancode", stream: { name: "Sky Sports Main Event", title: "4K 1080p", url: deadUrl } }],
      "https://api.playon.dev"
    );
    const rankedWithDead = StreamEngine.deduplicateAndRank(
      [
        { provider: "fancode", stream: { name: "Sky Sports Main Event", title: "4K 1080p", url: deadUrl } },
        { provider: "cricfy", stream: { name: "Backup Stream", title: "720p", url: healthyUrl } },
      ],
      "https://api.playon.dev",
      (u) => tracker.isDemoted(u, NOW + 10_000)
    );

    expect(rankedWithDead.streams[0]?.url).toBe(healthyUrl);
    const deadEntry = rankedWithDead.streams.find((s) => s.url === deadUrl);
    expect(deadEntry?.score).toBe((rankedHealthy.streams[0]?.score ?? 0) - 35);

    // Recovery restores full ranking
    tracker.recordSuccess(deadUrl);
    expect(tracker.isDemoted(deadUrl, NOW + 11_000)).toBe(false);
  });
});

describe("Production Hardening — HMAC-Signed Proxy, CORS Defense & Dynamic TTL Capping", () => {
  it("enforces HMAC-SHA256 signatures, signs M3U8 child/segment URLs, plays full chain, and prevents upstream CORS clobber", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const secret = "super-secret-playon-hmac-key-2026";
    const env: WorkerEnv = {
      PROXY_SIGNING_SECRET: secret,
      PROXY_SIG_TTL_SEC: "600",
      ALLOWED_ORIGINS: "https://player.playon.app",
    };

    const masterM3u8 = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080",
      "./variant/1080p.m3u8?v=2",
    ].join("\n");

    const variantM3u8 = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXTINF:4.0,",
      "seg001.ts?part=1",
    ].join("\n");

    let headBodyCanceled = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://cdn.example.com/live/master.m3u8") {
        if (init?.method === "HEAD") {
          const stream = new ReadableStream({
            cancel() {
              headBodyCanceled = true;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Access-Control-Allow-Origin": "https://evil-clobber.example",
            },
          });
        }
        return new Response(masterM3u8, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "https://evil-clobber.example",
          },
        });
      }
      if (url === "https://cdn.example.com/live/variant/1080p.m3u8?v=2") {
        return new Response(variantM3u8, {
          status: 200,
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
      }
      if (url === "https://cdn.example.com/live/variant/seg001.ts?part=1") {
        const range = new Headers(init?.headers).get("Range");
        expect(range).toBe("bytes=0-3");
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
          status: 206,
          headers: {
            "Content-Type": "video/mp2t",
            "Content-Range": "bytes 0-3/188",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const { app } = createApp();

    // 1. Unsigned -> 403 MISSING_SIGNATURE
    const unsignedRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster.m3u8"),
      env
    );
    expect(unsignedRes.status).toBe(403);
    expect(await unsignedRes.text()).toContain("MISSING_SIGNATURE");

    // 2. Signed with valid exp
    const expSec = Math.floor(NOW / 1000) + 300;
    const validSig = await signProxyPayload(
      { url: "https://cdn.example.com/live/master.m3u8", rewrite: true },
      expSec,
      secret
    );

    // 3. Tampered URL -> 403 INVALID_SIGNATURE
    const tamperedRes = await app.fetch(
      new Request(
        `https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fother.m3u8&exp=${expSec}&sig=${validSig}`
      ),
      env
    );
    expect(tamperedRes.status).toBe(403);
    expect(await tamperedRes.text()).toContain("INVALID_SIGNATURE");

    // 4. Expired -> 403 EXPIRED_SIGNATURE
    const expiredSec = Math.floor(NOW / 1000) - 10;
    const expiredSig = await signProxyPayload(
      { url: "https://cdn.example.com/live/master.m3u8", rewrite: true },
      expiredSec,
      secret
    );
    const expiredRes = await app.fetch(
      new Request(
        `https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster.m3u8&exp=${expiredSec}&sig=${expiredSig}`
      ),
      env
    );
    expect(expiredRes.status).toBe(403);
    expect(await expiredRes.text()).toContain("EXPIRED_SIGNATURE");

    // 5. Valid signed master.m3u8 with allowed Origin -> 200, CORS not clobbered, child URL is signed
    const masterRes = await app.fetch(
      new Request(
        `https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster.m3u8&exp=${expSec}&sig=${validSig}`,
        { headers: { Origin: "https://player.playon.app" } }
      ),
      env
    );
    expect(masterRes.status).toBe(200);
    expect(masterRes.headers.get("Access-Control-Allow-Origin")).toBe("https://player.playon.app");
    expect(masterRes.headers.get("Vary")).toContain("Origin");

    const rewrittenMaster = await masterRes.text();
    const variantLine = rewrittenMaster.split("\n").find((l) => l.startsWith("https://api.playon.dev/api/proxy?"));
    expect(variantLine).toBeTruthy();
    expect(variantLine).toContain("&sig=");
    expect(variantLine).toContain("&exp=");

    // 6. Follow signed variant URL -> get signed segment URL
    const variantRes = await app.fetch(
      new Request(variantLine!, { headers: { Origin: "https://player.playon.app" } }),
      env
    );
    expect(variantRes.status).toBe(200);
    const rewrittenVariant = await variantRes.text();
    const segLine = rewrittenVariant.split("\n").find((l) => l.startsWith("https://api.playon.dev/api/proxy?"));
    expect(segLine).toBeTruthy();

    // 7. Fetch signed segment with Range header -> 206 Partial Content & CORS enforced
    const segRes = await app.fetch(
      new Request(segLine!, {
        headers: { Range: "bytes=0-3", Origin: "https://player.playon.app" },
      }),
      env
    );
    expect(segRes.status).toBe(206);
    expect(segRes.headers.get("Access-Control-Allow-Origin")).toBe("https://player.playon.app");
    expect(new Uint8Array(await segRes.arrayBuffer())).toEqual(new Uint8Array([0x47, 0x40, 0x00, 0x10]));

    // 8. Disallowed Origin receives no Access-Control-Allow-Origin
    const blockedOriginRes = await app.fetch(
      new Request(
        `https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster.m3u8&exp=${expSec}&sig=${validSig}`,
        { headers: { Origin: "https://untrusted.attacker.test" } }
      ),
      env
    );
    expect(blockedOriginRes.status).toBe(200);
    expect(blockedOriginRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // 9. HEAD /api/proxy cancels upstream response body
    const headRes = await app.fetch(
      new Request(
        `https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster.m3u8&exp=${expSec}&sig=${validSig}`,
        { method: "HEAD" }
      ),
      env
    );
    expect(headRes.status).toBe(200);
    expect(headBodyCanceled).toBe(true);

    // Direct helper verification check
    const verified = await verifySignedProxyParams(
      { url: "https://cdn.example.com/live/master.m3u8", rewrite: true },
      String(expSec),
      validSig,
      secret,
      NOW
    );
    expect(verified.ok).toBe(true);
  });

  it("rewrites ./relative and ?query M3U8 references accurately and parses master playlists", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",URI="?track=eng"',
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
      "./sub/720p.m3u8",
    ].join("\n");

    const parsed = parseHlsMasterPlaylist(playlist, "https://cdn.example.com/live/channel/master.m3u8");
    expect(parsed).not.toBeNull();
    expect(parsed?.verified).toBe(true);
    expect(parsed?.maxHeight).toBe(720);

    const rewritten = rewriteM3u8Playlist(
      playlist,
      "https://cdn.example.com/live/channel/master.m3u8",
      "https://api.playon.dev",
      {}
    );
    expect(rewritten).toContain(encodeURIComponent("https://cdn.example.com/live/channel/master.m3u8?track=eng"));
    expect(rewritten).toContain(encodeURIComponent("https://cdn.example.com/live/channel/sub/720p.m3u8"));
  });

  it("caps Cache-Control max-age to remaining upstream token lifetime (no-store when < 10s left) and preserves unfiltered event metadata on filtered /api/events/:id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const soonExpSec = Math.floor(NOW / 1000) + 5; // 5 seconds remaining -> must become no-store
    const item: UpstreamMeta = {
      id: encodeRawId("sliv", {
        title: "India vs England",
        league: "ODI Series",
        startTime: "2026-11-24T13:30:00.000Z",
        status: "live",
        category: "cricket",
      }),
      name: "India vs England",
    };

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        return new Response(JSON.stringify({ metas: [item] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/catalog/tv/")) {
        return new Response(JSON.stringify({ metas: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/stream/tv/")) {
        return new Response(
          JSON.stringify({
            streams: [
              {
                name: "Sony Sports Ten 1",
                title: "1080p English",
                url: `https://cdn.sonyliv.com/live/eng.m3u8?hdnea=exp=${soonExpSec}~acl=/*`,
              },
              {
                name: "Sony Sports Ten 3",
                title: "720p Hindi",
                url: `https://cdn.sonyliv.com/live/hin.m3u8?hdnea=exp=${soonExpSec + 3600}~acl=/*`,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const { app } = createApp();
    const listRes = await app.fetch(new Request("https://api.playon.dev/api/events"));
    const listJson = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = listJson.data[0]?.id;
    expect(id).toBeTruthy();

    // Unfiltered request contains the 5s-remaining English token -> must be Cache-Control: no-store
    const unfilteredRes = await app.fetch(
      new Request(`https://api.playon.dev/api/events/${id}?inspect=false`)
    );
    expect(unfilteredRes.status).toBe(200);
    expect(unfilteredRes.headers.get("Cache-Control")).toBe("no-store");

    // Filtered by Hindi (token valid 1h): returns 1 stream with cacheable TTL, while preserving unfiltered event-level metadata (1080p, streamCount 2)
    const filteredRes = await app.fetch(
      new Request(`https://api.playon.dev/api/events/${id}?language=hin&inspect=false`)
    );
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.headers.get("Cache-Control")).toContain("max-age=20");
    const filteredJson = (await filteredRes.json()) as {
      data: { maxQuality: string; streamCount: number; streams: Array<{ languageName: string }> };
    };
    expect(filteredJson.data.streams).toHaveLength(1);
    expect(filteredJson.data.streams[0]?.languageName).toBe("Hindi");
    expect(filteredJson.data.maxQuality).toBe("1080p");
    expect(filteredJson.data.streamCount).toBe(2);
  });
});

describe("Production Hardening — Cache-Busting Defense, Origin Isolation, Subrequest Budget & Concurrency", () => {
  it("strips unknown query params to defeat cache-busting, isolates proxy origin in cache key, validates /api/facets status, and returns 405 with Allow header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    let catalogFetches = 0;
    const item: UpstreamMeta = {
      id: encodeRawId("fancode", {
        title: "Real Madrid vs Barcelona",
        league: "La Liga",
        startTime: "2026-11-24T14:00:00.000Z",
        status: "live",
        category: "football",
      }),
      name: "Real Madrid vs Barcelona",
    };

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        catalogFetches++;
        return new Response(JSON.stringify({ metas: [item] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/catalog/tv/")) {
        return new Response(JSON.stringify({ metas: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/stream/tv/")) {
        return new Response(
          JSON.stringify({
            streams: [{ name: "ESPN", title: "1080p", url: "https://cdn.example.com/laliga/master.m3u8" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const { app, cache, telemetry } = createApp();

    // 405 Method Not Allowed on POST
    const postRes = await app.fetch(new Request("https://api.playon.dev/api/events", { method: "POST" }));
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");

    // Invalid /api/facets?status=invalid -> 400
    const badFacets = await app.fetch(new Request("https://api.playon.dev/api/facets?status=bogus"));
    expect(badFacets.status).toBe(400);

    // Cache-busting query params hit the exact same canonical L1 cache key
    const r1 = await app.fetch(new Request("https://api.playon.dev/api/events?sport=football"));
    expect(r1.headers.get("X-Cache")).toBe("MISS");
    const r2 = await app.fetch(
      new Request("https://api.playon.dev/api/events?sport=football&utm_source=bot&rand=999999&cb=abc")
    );
    expect(r2.headers.get("X-Cache")).toBe("HIT-L1");
    expect(catalogFetches).toBe(1);

    // Origin isolation on /api/stream/:id (different Host must not receive stale proxyUrl origin)
    const eventsJson = (await r1.json()) as { data: Array<{ id: string }> };
    const eventId = eventsJson.data[0]!.id;

    const sHostA = await app.fetch(new Request(`https://host-a.playon.dev/api/stream/${eventId}?inspect=false`));
    const sHostB = await app.fetch(new Request(`https://host-b.playon.dev/api/stream/${eventId}?inspect=false`));
    const jsonA = (await sHostA.json()) as { data: { streams: Array<{ proxyUrl: string }> } };
    const jsonB = (await sHostB.json()) as { data: { streams: Array<{ proxyUrl: string }> } };
    expect(jsonA.data.streams[0]?.proxyUrl.startsWith("https://host-a.playon.dev/api/proxy?")).toBe(true);
    expect(jsonB.data.streams[0]?.proxyUrl.startsWith("https://host-b.playon.dev/api/proxy?")).toBe(true);

    // 5,000 unique cache-busting requests keep L1 bounded <= 200 and telemetry route buckets <= 10
    for (let i = 0; i < 5000; i++) {
      const res = await app.fetch(
        new Request(`https://api.playon.dev/api/events?sport=football&q=tok${i % 350}&rand=${i}`)
      );
      expect(res.status).toBe(200);
    }
    expect(cache.getStats().entries).toBeLessThanOrEqual(200);
    const snap = telemetry.snapshot();
    expect(Object.keys(snap.routes).length).toBeLessThanOrEqual(10);
  });

  it("coalesces 50 concurrent cold requests into a single catalog refresh and sheds hedges/probes under RequestBudget", async () => {
    let fancodeCalls = 0;
    const item: UpstreamMeta = {
      id: encodeRawId("fancode", {
        title: "Lakers vs Celtics",
        league: "NBA",
        startTime: "2026-11-24T14:00:00.000Z",
        status: "live",
        category: "basketball",
      }),
      name: "Lakers vs Celtics",
    };

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (url.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        fancodeCalls++;
        return new Response(JSON.stringify({ metas: [item] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ metas: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { app } = createApp();

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, idx) =>
        app.fetch(new Request(`https://api.playon.dev/api/events?sport=basketball&utm=${idx}`))
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    expect(fancodeCalls).toBe(1);

    // RequestBudget strictly caps total subrequests <= 42 and sheds hedges/probes early
    const budget = new RequestBudget(42);
    for (let i = 0; i < 30; i++) expect(budget.tryAcquire("critical")).toBe(true);
    expect(budget.tryAcquire("hedge")).toBe(false); // shed at softHedgeThreshold (30)
    for (let i = 0; i < 4; i++) expect(budget.tryAcquire("probe")).toBe(true); // 30..33
    expect(budget.tryAcquire("probe")).toBe(false); // shed at softProbeThreshold (34)
    for (let i = 0; i < 8; i++) expect(budget.tryAcquire("critical")).toBe(true); // 34..41
    expect(budget.tryAcquire("critical")).toBe(false); // hard cap at 42
    expect(budget.used).toBe(42);
  });

  it("returns degraded soft-quorum snapshot with Cache-Control: no-store when a straggler provider fails/hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const item: UpstreamMeta = {
      id: encodeRawId("fancode", {
        title: "Manchester City vs Liverpool",
        league: "Premier League",
        startTime: "2026-11-24T14:00:00.000Z",
        status: "live",
        category: "football",
      }),
      name: "Manchester City vs Liverpool",
    };

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        return new Response(JSON.stringify({ metas: [item] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/catalog/tv/cnc_CricifyLiveEvents_tv.json")) {
        return new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(JSON.stringify({ metas: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { app } = createApp();
    const res = await app.fetch(new Request("https://api.playon.dev/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(1);

    const healthRes = await app.fetch(new Request("https://api.playon.dev/api/health"));
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      data: { status: string; catalog: string; providers: { total: number; healthy: number } };
    };
    expect(healthJson.data.catalog).toBe("degraded");
    expect(healthJson.data.providers.healthy).toBe(5);
  });
});
