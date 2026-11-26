import { afterEach, describe, expect, it, vi } from "vitest";
import { convertDashToHls, isDashManifest, parseIsoDurationSec } from "../src/domain/dash";
import { buildSignedProxyUrl, verifySignedProxyParams } from "../src/edge/signing";
import { StreamProxy } from "../src/edge/proxy";
import { CNC_DISABLED_EXTENSIONS, CNC_ENABLED_EXTENSIONS, UpstreamClient } from "../src/edge/upstream";
import { createApp } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SAMPLE_LIVE_TIMELINE_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="dynamic" availabilityStartTime="2026-11-26T10:00:00Z" minimumUpdatePeriod="PT4S">
  <BaseURL>https://cdn.example.com/live/match1/</BaseURL>
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" frameRate="50/1">
      <SegmentTemplate timescale="90000" initialization="init_$RepresentationID$.mp4" media="chunk_$RepresentationID$_$Time$.m4s" startNumber="100">
        <SegmentTimeline>
          <S t="900000" d="180000" r="2"/>
          <S d="180000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v720" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="eng">
      <SegmentTemplate timescale="48000" initialization="init_$RepresentationID$.mp4" media="seg_$RepresentationID$_$Number%05d$.m4s" startNumber="10">
        <SegmentTimeline>
          <S t="0" d="96000" r="1"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const SAMPLE_DRM_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="dynamic">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="11223344-5566-7788-99aa-bbccddeeff00"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="init.mp4" media="seg_$Number$.m4s"/>
      <Representation id="v1" bandwidth="3000000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const SAMPLE_SEGLIST_VOD_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="vod1" bandwidth="1800000" width="1280" height="720" codecs="avc1.4d401f">
        <SegmentList timescale="1" duration="4" startNumber="1">
          <Initialization sourceURL="vod/init.mp4"/>
          <SegmentURL media="vod/seg1.m4s"/>
          <SegmentURL media="vod/seg2.m4s"/>
          <SegmentURL media="vod/seg3.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const SAMPLE_FIXED_LIVE_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="dynamic" availabilityStartTime="2026-11-26T10:00:00Z">
  <Period start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="i_$RepresentationID$.mp4" media="m_$RepresentationID$_$Number%04d$_$$.m4s"/>
      <Representation id="hd" bandwidth="4000000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("Pure MPEG-DASH -> HLS v7 fMP4 Converter", () => {
  it("parses ISO 8601 durations and detects MPD payloads", () => {
    expect(parseIsoDurationSec("PT1H2M3.5S")).toBe(3723.5);
    expect(parseIsoDurationSec("P1DT30S")).toBe(86430);
    expect(parseIsoDurationSec("invalid")).toBeNull();
    expect(isDashManifest(SAMPLE_LIVE_TIMELINE_MPD)).toBe(true);
    expect(isDashManifest("#EXTM3U\n#EXT-X-VERSION:3")).toBe(false);
  });

  it("converts unencrypted SegmentTemplate+SegmentTimeline MPD into HLS v7 master & media playlists", () => {
    const master = convertDashToHls(SAMPLE_LIVE_TIMELINE_MPD, "https://origin.example.com/manifest.mpd", {
      nowMs: Date.parse("2026-11-26T10:05:00Z"),
      formatPlaylistUrl: (id) => `https://edge.test/api/proxy?url=mpd&hls=1&rep=${id}`,
      formatMediaUrl: (u) => `https://edge.test/api/proxy?url=${encodeURIComponent(u)}&rewrite=false`,
    });
    expect(master.ok).toBe(true);
    if (!master.ok) return;
    expect(master.isLive).toBe(true);
    expect(master.m3u8).toContain("#EXT-X-VERSION:7");
    expect(master.m3u8).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"');
    expect(master.m3u8).toContain("RESOLUTION=1920x1080,FRAME-RATE=50");
    expect(master.m3u8).toContain('CODECS="avc1.640028,mp4a.40.2"');
    // Highest resolution sorted first
    expect(master.m3u8.indexOf("rep=v1080")).toBeLessThan(master.m3u8.indexOf("rep=v720"));

    const videoMedia = convertDashToHls(SAMPLE_LIVE_TIMELINE_MPD, "https://origin.example.com/manifest.mpd", {
      repId: "v1080",
      nowMs: Date.parse("2026-11-26T10:05:00Z"),
      formatPlaylistUrl: (id) => id,
      formatMediaUrl: (u) => `PROXY:${u}`,
    });
    expect(videoMedia.ok).toBe(true);
    if (!videoMedia.ok) return;
    expect(videoMedia.m3u8).toContain('#EXT-X-MAP:URI="PROXY:https://cdn.example.com/live/match1/init_v1080.mp4"');
    expect(videoMedia.m3u8).toContain("#EXT-X-MEDIA-SEQUENCE:100");
    expect(videoMedia.m3u8).toContain("PROXY:https://cdn.example.com/live/match1/chunk_v1080_900000.m4s");
    expect(videoMedia.m3u8).toContain("PROXY:https://cdn.example.com/live/match1/chunk_v1080_1440000.m4s");
    expect(videoMedia.m3u8).not.toContain("#EXT-X-ENDLIST");

    const audioMedia = convertDashToHls(SAMPLE_LIVE_TIMELINE_MPD, "https://origin.example.com/manifest.mpd", {
      repId: "a128",
      nowMs: Date.parse("2026-11-26T10:05:00Z"),
      formatPlaylistUrl: (id) => id,
      formatMediaUrl: (u) => `PROXY:${u}`,
    });
    expect(audioMedia.ok).toBe(true);
    if (!audioMedia.ok) return;
    expect(audioMedia.m3u8).toContain("seg_a128_00010.m4s");
    expect(audioMedia.m3u8).toContain("seg_a128_00011.m4s");
  });

  it("supports fixed-duration live sliding window and SegmentList VOD playlists", () => {
    // 100s after availabilityStartTime with 4s segments -> edgeSeq = 1 + (25 - 1) = 25, window 16..25
    const live = convertDashToHls(SAMPLE_FIXED_LIVE_MPD, "https://cdn.example.com/live/stream.mpd", {
      repId: "hd",
      nowMs: Date.parse("2026-11-26T10:01:40Z"),
      formatPlaylistUrl: (id) => id,
      formatMediaUrl: (u) => u,
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.m3u8).toContain("#EXT-X-MEDIA-SEQUENCE:16");
    expect(live.m3u8).toContain("https://cdn.example.com/live/m_hd_0025_$.m4s");
    expect(live.m3u8).not.toContain("#EXT-X-ENDLIST");

    const vod = convertDashToHls(SAMPLE_SEGLIST_VOD_MPD, "https://cdn.example.com/app/stream.mpd", {
      repId: "vod1",
      nowMs: 0,
      formatPlaylistUrl: (id) => id,
      formatMediaUrl: (u) => u,
    });
    expect(vod.ok).toBe(true);
    if (!vod.ok) return;
    expect(vod.isLive).toBe(false);
    expect(vod.m3u8).toContain('#EXT-X-MAP:URI="https://cdn.example.com/app/vod/init.mp4"');
    expect(vod.m3u8).toContain("https://cdn.example.com/app/vod/seg3.m4s");
    expect(vod.m3u8).toContain("#EXT-X-ENDLIST");
  });

  it("rejects DRM-protected MPDs with 422, missing tracks with 404, and filters SSRF BaseURLs", () => {
    const drm = convertDashToHls(SAMPLE_DRM_MPD, "https://cdn.example.com/drm.mpd", {
      nowMs: 0, formatPlaylistUrl: (id) => id, formatMediaUrl: (u) => u,
    });
    expect(drm.ok).toBe(false);
    if (!drm.ok) {
      expect(drm.status).toBe(422);
      expect(drm.code).toBe("DASH_DRM_UNSUPPORTED");
    }

    const missing = convertDashToHls(SAMPLE_SEGLIST_VOD_MPD, "https://cdn.example.com/stream.mpd", {
      repId: "does_not_exist", nowMs: 0, formatPlaylistUrl: (id) => id, formatMediaUrl: (u) => u,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(404);
      expect(missing.code).toBe("DASH_TRACK_NOT_FOUND");
    }

    const ssrfMpd = SAMPLE_SEGLIST_VOD_MPD.replace("<Period>", "<BaseURL>http://127.0.0.1:8080/internal/</BaseURL><Period>");
    const blocked = convertDashToHls(ssrfMpd, "https://cdn.example.com/stream.mpd", {
      repId: "vod1",
      nowMs: 0,
      formatPlaylistUrl: (id) => id,
      formatMediaUrl: (u) => u,
      isAllowedUrl: (href) => StreamProxy.isSafeTargetUrl(href),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(422);
  });

  it("disambiguates duplicate video/audio Representation@id while preserving $RepresentationID$ and expands r='-1' repeats", () => {
    const dupAndRepeatMpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="static" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="v_init_$RepresentationID$.mp4" media="v_$RepresentationID$_$Number$.m4s" startNumber="1">
        <SegmentTimeline><S t="0" d="4000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="3000000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="eng">
      <SegmentTemplate timescale="1000" initialization="a_init_$RepresentationID$.mp4" media="a_$RepresentationID$_$Number$.m4s" startNumber="1">
        <SegmentTimeline><S t="0" d="4000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    const master = convertDashToHls(dupAndRepeatMpd, "https://cdn.example.com/live/s.mpd", {
      nowMs: 0, formatPlaylistUrl: (id) => `REP:${id}`, formatMediaUrl: (u) => u,
    });
    expect(master.ok).toBe(true);
    if (!master.ok) return;
    expect(master.m3u8).toContain("REP:1");
    expect(master.m3u8).toContain('URI="REP:a:1"');

    // Audio track uses unique key "a:1" yet expands $RepresentationID$ to original "1" and emits 5 segments (20s / 4s)
    const aud = convertDashToHls(dupAndRepeatMpd, "https://cdn.example.com/live/s.mpd", {
      repId: "a:1", nowMs: 0, formatPlaylistUrl: (id) => id, formatMediaUrl: (u) => u,
    });
    expect(aud.ok).toBe(true);
    if (!aud.ok) return;
    expect(aud.m3u8).toContain("a_init_1.mp4");
    expect(aud.m3u8.split("#EXTINF:").length - 1).toBe(5);
    expect(aud.m3u8).toContain("a_1_5.m4s");
  });
});

describe("Proxy Opt-In DASH-to-HLS & Stream Endpoint Integration", () => {
  it("keeps default /api/proxy behavior 100% untouched and converts only when ?hls=1 is passed", async () => {
    globalThis.fetch = vi.fn(async () => new Response(SAMPLE_LIVE_TIMELINE_MPD, {
      status: 200,
      headers: { "Content-Type": "application/dash+xml" },
    })) as unknown as typeof fetch;

    const rawRes = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fstream.mpd"));
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("content-type")).toContain("application/dash+xml");
    expect(await rawRes.text()).toContain("<MPD");

    const hlsRes = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fstream.mpd&hls=1"));
    expect(hlsRes.status).toBe(200);
    expect(hlsRes.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    const masterText = await hlsRes.text();
    expect(masterText).toContain("#EXTM3U");
    expect(masterText).toContain("&hls=1&rep=v1080");

    const headRes = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fstream.mpd&hls=1", { method: "HEAD" }));
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    expect(headRes.body).toBeNull();
  });

  it("enforces and propagates HMAC-SHA256 signatures across DASH-to-HLS master -> media -> segments", async () => {
    const secret = "test-dash-hls-hmac-secret-32-bytes";
    const mpdUrl = "https://cdn.example.com/live/match.mpd";
    const expSec = Math.floor(Date.now() / 1000) + 3600;

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u === mpdUrl) return new Response(SAMPLE_LIVE_TIMELINE_MPD, { status: 200, headers: { "Content-Type": "application/dash+xml" } });
      return new Response("SEGMENT_BYTES", { status: 200, headers: { "Content-Type": "video/mp4" } });
    }) as unknown as typeof fetch;

    // Unsigned ?hls=1 is blocked
    const unsigned = await StreamProxy.handleProxyRequest(new Request(`https://playon.test/api/proxy?url=${encodeURIComponent(mpdUrl)}&hls=1`), { PROXY_SIGNING_SECRET: secret });
    expect(unsigned.status).toBe(403);

    // Tampered: signature built WITHOUT hls=1 cannot be upgraded to ?hls=1
    const baseSigned = await buildSignedProxyUrl("https://playon.test", { url: mpdUrl, rewrite: true }, secret, expSec);
    const tampered = await StreamProxy.handleProxyRequest(new Request(`${baseSigned}&hls=1`), { PROXY_SIGNING_SECRET: secret });
    expect(tampered.status).toBe(403);

    // Properly signed ?hls=1 -> master -> variant media -> init segment all verify cleanly
    const masterUrl = await buildSignedProxyUrl("https://playon.test", { url: mpdUrl, rewrite: true, hls: true }, secret, expSec);
    const masterRes = await StreamProxy.handleProxyRequest(new Request(masterUrl), { PROXY_SIGNING_SECRET: secret });
    expect(masterRes.status).toBe(200);
    const masterBody = await masterRes.text();
    const variantLine = masterBody.split("\n").find((l) => l.startsWith("https://playon.test/api/proxy?") && l.includes("rep=v1080"));
    expect(variantLine).toBeTruthy();

    const mediaRes = await StreamProxy.handleProxyRequest(new Request(variantLine!), { PROXY_SIGNING_SECRET: secret });
    expect(mediaRes.status).toBe(200);
    const mediaBody = await mediaRes.text();
    const segLine = mediaBody.split("\n").find((l) => l.startsWith("https://playon.test/api/proxy?") && l.includes("chunk_v1080_"));
    expect(segLine).toBeTruthy();

    const segRes = await StreamProxy.handleProxyRequest(new Request(segLine!), { PROXY_SIGNING_SECRET: secret });
    expect(segRes.status).toBe(200);
    expect(await segRes.text()).toBe("SEGMENT_BYTES");
  });

  it("returns 422 on DRM MPD and non-MPD responses when ?hls=1 is requested", async () => {
    globalThis.fetch = vi.fn(async () => new Response(SAMPLE_DRM_MPD, { status: 200, headers: { "Content-Type": "application/dash+xml" } })) as unknown as typeof fetch;
    const drmRes = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fdrm.mpd&hls=1"));
    expect(drmRes.status).toBe(422);
    const drmJson = (await drmRes.json()) as { code: string; title: string };
    expect(drmJson.code).toBe("DASH_DRM_UNSUPPORTED");
    expect(drmJson.title).toBe("Unprocessable Entity");

    globalThis.fetch = vi.fn(async () => new Response("#EXTM3U\n#EXT-X-VERSION:3\n", { status: 200 })) as unknown as typeof fetch;
    const nonMpd = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fnot.m3u8&hls=1"));
    expect(nonMpd.status).toBe(422);
  });

  it("strips Range header on ?hls=1 MPD fetches and returns 504 UPSTREAM_TIMEOUT on stalled upstream", async () => {
    let forwardedRange: string | null = null;
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedRange = new Headers(init?.headers).get("Range");
      return new Response(SAMPLE_SEGLIST_VOD_MPD, { status: 200, headers: { "Content-Type": "application/dash+xml" } });
    }) as unknown as typeof fetch;

    const res = await StreamProxy.handleProxyRequest(new Request("https://playon.test/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fs.mpd&hls=1", {
      headers: { Range: "bytes=0-1024" },
    }));
    expect(res.status).toBe(200);
    expect(forwardedRange).toBeNull();

    // Timeout check directly on fetchSafeRedirects with 25ms timeout
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
    const timed = await StreamProxy.fetchSafeRedirects("https://cdn.example.com/hang.ts", "GET", new Headers(), 2, undefined, undefined, undefined, 25);
    expect(timed.ok).toBe(false);
    if (!timed.ok) {
      expect(timed.status).toBe(504);
      expect(timed.code).toBe("UPSTREAM_TIMEOUT");
    }
  });

  it("wires opt-in ?dashToHls=true on /api/stream/:id only for unencrypted DASH (default OFF)", async () => {
    const rawId = `SportzXLiveEvents::${btoa(JSON.stringify({ id: "m1", title: "India vs Australia", category: "Cricket", status: "live" }))}`;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) {
        return new Response(JSON.stringify({ metas: [{ id: rawId, name: "India vs Australia", type: "tv" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/catalog/tv/")) return new Response(JSON.stringify({ metas: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/stream/tv/")) {
        return new Response(JSON.stringify({
          streams: [
            { name: "Clear DASH", title: "Star Sports 1", url: "https://cdn.example.com/clear/live.mpd" },
            { name: "DRM DASH", title: "Star Sports 2", url: "https://cdn.example.com/drm/live.mpd?drmScheme=clearkey&drmLicense=00112233445566778899aabbccddeeff:ffeeddccbbaa99887766554433221100" },
            { name: "HLS Feed", title: "Sky Sports", url: "https://cdn.example.com/hls/master.m3u8" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const { app } = createApp();
    const evRes = await app.fetch(new Request("https://playon.test/api/events"));
    const evJson = (await evRes.json()) as { data: Array<{ id: string }> };
    const eventId = evJson.data[0]!.id;

    // Default OFF: no &hls=1 anywhere
    const defRes = await app.fetch(new Request(`https://playon.test/api/stream/${eventId}?inspect=false`));
    const defJson = (await defRes.json()) as { data: { streams: Array<{ url: string; proxyUrl: string; protocol: string; drm: unknown }> } };
    expect(defJson.data.streams.every((s) => !s.proxyUrl.includes("hls=1"))).toBe(true);

    // Opt-in ?dashToHls=true: ONLY unencrypted DASH gets &hls=1
    const optRes = await app.fetch(new Request(`https://playon.test/api/stream/${eventId}?inspect=false&dashToHls=true`));
    const optJson = (await optRes.json()) as { data: { streams: Array<{ url: string; proxyUrl: string; protocol: string; drm: unknown }> } };
    const clearDash = optJson.data.streams.find((s) => s.url.includes("/clear/live.mpd"))!;
    const drmDash = optJson.data.streams.find((s) => s.url.includes("/drm/live.mpd"))!;
    const hlsFeed = optJson.data.streams.find((s) => s.url.includes("/hls/master.m3u8"))!;
    expect(clearDash.proxyUrl).toContain("&hls=1");
    expect(drmDash.proxyUrl).not.toContain("hls=1");
    expect(hlsFeed.proxyUrl).not.toContain("hls=1");

    // Signed mode with ?dashToHls=true produces valid HMAC signature for hls=1
    const secret = "signed-stream-dash-hls-secret";
    const sigRes = await app.fetch(new Request(`https://playon.test/api/stream/${eventId}?inspect=false&dashToHls=true`), { PROXY_SIGNING_SECRET: secret });
    const sigJson = (await sigRes.json()) as { data: { streams: Array<{ url: string; proxyUrl: string }> } };
    const signedClear = sigJson.data.streams.find((s) => s.url.includes("/clear/live.mpd"))!;
    const sp = new URL(signedClear.proxyUrl).searchParams;
    expect(sp.get("hls")).toBe("1");
    const verified = await verifySignedProxyParams({ url: sp.get("url")!, rewrite: true, hls: true, rep: null }, sp.get("exp"), sp.get("sig"), secret);
    expect(verified.ok).toBe(true);
  });
});

describe("CNCVerse 6-Provider Auto-Provisioning & Rotating Profile Manager", () => {
  it("auto-provisions anonymous 6-provider profile and routes both catalog & streams via /u/<pid>/...", async () => {
    const seenUrls: string[] = [];
    let postedBody: Record<string, unknown> | null = null;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(`${init?.method ?? "GET"} ${u}`);
      if (init?.method === "POST" && u.includes("/api/profile/") && u.endsWith("/set")) {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, enabledCount: 6 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/catalog/tv/")) return new Response(JSON.stringify({ metas: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/stream/tv/")) return new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = new UpstreamClient(["https://cncverse.dpdns.org"]);
    await Promise.all([
      client.fetchCatalog("cricify", "cricify_live"),
      client.fetchCatalog("sportzx", "sportzx_live"),
    ]);
    await client.fetchStreams("CricifyLiveEvents::abc");

    // Single-flight: only ONE profile creation POST even under concurrent fetches
    const postCalls = seenUrls.filter((s) => s.startsWith("POST "));
    expect(postCalls.length).toBe(1);
    const pidMatch = /\/api\/profile\/(p_[a-z0-9]{12})\/set$/.exec(postCalls[0]!);
    expect(pidMatch).not.toBeNull();
    const pid = pidMatch![1]!;

    // Strictly enables CricifyLiveEvents and disables non-sports defaults (ClownIPTV, JioTvPlus, etc.)
    expect(postedBody).toEqual({
      enabledExtensions: [...CNC_ENABLED_EXTENSIONS],
      disabledExtensions: [...CNC_DISABLED_EXTENSIONS],
      disabledCatalogs: [],
    });
    expect(CNC_DISABLED_EXTENSIONS).toContain("ClownIPTV");
    expect(CNC_DISABLED_EXTENSIONS).toContain("JioTvPlus");

    // Both catalog and stream requests are routed through /u/<pid>/
    expect(seenUrls.some((s) => s.includes(`/u/${pid}/catalog/tv/cricify_live.json`))).toBe(true);
    expect(seenUrls.some((s) => s.includes(`/u/${pid}/stream/tv/CricifyLiveEvents%3A%3Aabc.json`))).toBe(true);
    expect(client.getProfileStatus().mode).toBe("auto");
    expect(client.getProfileStatus().active).toBe(true);
  });

  it("rotates profile reactively with transparent 1x retry on HTTP 429 without double-counting rotations, and supports CNC_PROFILES pool", async () => {
    const createdPids: string[] = [];
    let failFirst429 = true;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && u.includes("/api/profile/")) {
        const m = /\/api\/profile\/(p_[a-z0-9]+)\/set/.exec(u);
        if (m?.[1]) createdPids.push(m[1]);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (failFirst429 && u.includes("/catalog/tv/")) {
        failFirst429 = false;
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response(JSON.stringify({ metas: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = new UpstreamClient(["https://cncverse.dpdns.org"]);
    const res = await client.fetchCatalog("cricify", "cricify_live");
    expect(res.items).toEqual([]);
    expect(createdPids.length).toBe(2);
    expect(createdPids[0]).not.toBe(createdPids[1]);
    expect(client.getProfileStatus().rotations).toBe(1);

    // Static pool mode: never calls POST /api/profile/.../set and rotates on TTL/429
    const poolClient = new UpstreamClient(["https://cncverse.dpdns.org"]);
    const p1 = await poolClient.resolveProfilePrefix({ profilesRaw: "p_poolone11111, p_pooltwo22222", ttlSecRaw: "300" });
    expect(p1).toBe("/u/p_poolone11111");
    expect(poolClient.getProfileStatus().mode).toBe("pool");
  });

  it("falls back cleanly to root path when profile endpoint is unavailable", async () => {
    const requestedPaths: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requestedPaths.push(u.pathname);
      if (u.pathname.startsWith("/api/profile/")) return new Response("Unavailable", { status: 503 });
      return new Response(JSON.stringify({ metas: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = new UpstreamClient(["https://cncverse.dpdns.org"]);
    const res = await client.fetchCatalog("sportzx", "sportzx_live");
    expect(res.items).toEqual([]);
    expect(requestedPaths).toContain("/catalog/tv/sportzx_live.json");
    expect(client.getProfileStatus().mode).toBe("fallback");
  });
});
