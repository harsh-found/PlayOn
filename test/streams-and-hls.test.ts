import { afterEach, describe, expect, it, vi } from "vitest";
import { DrmDetector } from "../src/domain/drm";
import { StreamEngine } from "../src/domain/streams";
import { HlsInspector } from "../src/edge/hls";

describe("StreamEngine Lossless Dedup, Ranking & HlsInspector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves distinct languages, qualities, non-default ports, query params, and DRM while collapsing token/CDN duplicates losslessly", () => {
    const ck = "0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210";
    const { streams, audit } = StreamEngine.deduplicateAndRank(
      [
        // Spam excluded
        {
          provider: "sportzx",
          stream: { name: "Donate now", title: "Join Telegram t.me/abc", url: "https://t.me/abc" },
        },
        // Non-media excluded
        {
          provider: "playztv",
          stream: { name: "Banner", url: "https://cdn.example.com/poster.png" },
        },
        // Same AIV CDN stream with rotating token & host -> MUST collapse with lossless mirrors
        {
          provider: "sportzx",
          stream: {
            name: "Amazon Prime Video 1080p",
            title: "Amazon Prime Video 1080p English",
            url: "https://edge1.aiv-cdn.net/live/match/master.m3u8?hdnea=exp=100~hmac=aaa&t=1",
          },
        },
        {
          provider: "cricify",
          stream: {
            name: "Amazon Prime Video 1080p",
            title: "Amazon Prime Video 1080p English",
            url: "https://edge2.aiv-cdn.net/live/match/master.m3u8?hdnea=exp=200~hmac=bbb&t=2",
          },
        },
        // Distinct language (Hindi) on same path -> MUST stay separate
        {
          provider: "playztv",
          stream: {
            name: "Amazon Prime Video 1080p Hindi",
            title: "Amazon Prime Video 1080p Hindi",
            url: "https://edge1.aiv-cdn.net/live/match/master.m3u8?hdnea=exp=300",
          },
        },
        // Distinct non-default port -> MUST stay separate
        {
          provider: "livxow",
          stream: {
            name: "Sky Sports 720p",
            url: "https://stream.example.net:8080/live/sky.m3u8",
          },
        },
        {
          provider: "sktech",
          stream: {
            name: "Sky Sports 720p",
            url: "https://stream.example.net:8443/live/sky.m3u8",
          },
        },
        // Load-bearing query param `signal` -> MUST stay separate
        {
          provider: "playfy",
          stream: {
            name: "Star Sports 1 1080p",
            url: "https://cdn.example.net/live/index.m3u8?signal=main",
          },
        },
        {
          provider: "playfy",
          stream: {
            name: "Star Sports 1 1080p",
            url: "https://cdn.example.net/live/index.m3u8?signal=backup",
          },
        },
        // DASH + Bridged HLS pointing to same origin -> prefers HLS primary and preserves DASH in mirrors
        {
          provider: "sportzx",
          stream: {
            name: "Sony LIV 1080p",
            url: "https://slivcdn.com/live/match.mpd?hdnea=exp=1",
            clearkey: ck,
          },
        },
        {
          provider: "playztv",
          stream: {
            name: "Sony LIV 1080p",
            url: `http://129.225.106.195/d/master.m3u8?d=${encodeURIComponent("https://slivcdn.com/live/match.mpd?hdnea=exp=2")}&clearkey=${ck}`,
          },
        },
      ],
      "https://api.playon.dev"
    );

    expect(audit.excludedCount).toBe(2);
    expect(audit.exclusions.map((e) => e.reason).sort()).toEqual(["DONATION_SPAM", "NON_MEDIA_URL"]);
    // 1 (AIV Eng collapsed) + 1 (AIV Hin) + 2 (ports) + 2 (signal) + 1 (Sony bridged HLS + DASH mirror) = 7
    expect(streams.length).toBe(7);

    // Verify 1-based ranking and descending score
    expect(streams[0]!.rank).toBe(1);
    for (let i = 1; i < streams.length; i++) {
      expect(streams[i]!.rank).toBe(i + 1);
      expect(streams[i - 1]!.score).toBeGreaterThanOrEqual(streams[i]!.score);
    }

    // Verify AIV mirror preservation
    const aivEng = streams.find((s) => s.broadcaster === "Amazon Prime Video" && s.language === "eng");
    expect(aivEng?.providers).toEqual(["cricify", "sportzx"]);
    expect(aivEng?.mirrors.length).toBe(1);

    // Verify DASH-to-bridged-HLS upgrade
    const sony = streams.find((s) => s.broadcaster === "Sony LIV");
    expect(sony?.protocol).toBe("hls");
    expect(sony?.drm?.scheme).toBe("clearkey");
    expect(sony?.drm?.keys?.[0]?.kid).toBe("0123456789abcdef0123456789abcdef");
    expect(sony?.mirrors.some((m) => m.protocol === "dash")).toBe(true);
  });

  it("detects ClearKey multi-key and Widevine cleanly", () => {
    const k1 = "0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210";
    const k2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const drm = DrmDetector.detect("", `${k1},${k2}`);
    expect(drm?.scheme).toBe("clearkey");
    expect(drm?.keys?.length).toBe(2);
    expect(DrmDetector.detect("Widevine L1 Stream")).toEqual({ scheme: "widevine" });
  });

  it("parses HLS master playlists and enforces egress checks, size caps, and non-2xx cancellation", async () => {
    const inspector = new HlsInspector();

    // Private IP blocked immediately before fetch
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await inspector.inspect("http://127.0.0.1/live.m3u8")).toBeNull();
    expect(await inspector.inspect("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Redirect to private IP blocked
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/internal.m3u8" } })
    );
    expect(await inspector.inspect("https://cdn.example.net/redirect.m3u8")).toBeNull();

    // Oversized > 512 KiB rejected
    fetchSpy.mockResolvedValueOnce(
      new Response("#EXTM3U\n" + "x".repeat(600 * 1024), {
        status: 200,
        headers: { "Content-Length": String(600 * 1024) },
      })
    );
    expect(await inspector.inspect("https://cdn.example.net/huge.m3u8")).toBeNull();

    // Valid HLS master playlist parsed with renditions
    fetchSpy.mockResolvedValueOnce(
      new Response(
        [
          "#EXTM3U",
          '#EXT-X-STREAM-INF:BANDWIDTH=6500000,RESOLUTION=1920x1080,FRAME-RATE=50,CODECS="avc1.64002a"',
          "1080p/index.m3u8",
          "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,FRAME-RATE=25",
          "720p/index.m3u8",
        ].join("\n"),
        { status: 200 }
      )
    );
    const probe = await inspector.inspect("https://cdn.example.net/live/master.m3u8");
    expect(probe?.verified).toBe(true);
    expect(probe?.maxHeight).toBe(1080);
    expect(probe?.renditions.length).toBe(2);
    expect(probe?.renditions[0]?.url).toBe("https://cdn.example.net/live/1080p/index.m3u8");
  });

  it("enforces strict 2-tier stream identity, truthful maxh/numeric quality, CNCVerse donation filtering, and raw IP/extensionless URLs", () => {
    const { streams, audit } = StreamEngine.deduplicateAndRank(
      [
        // Real CNCVerse donation banners (externalUrl & cncverse.pages.dev) -> excluded
        {
          provider: "sportzx",
          stream: { name: "Donate", externalUrl: "https://cncverse.pages.dev" },
        },
        {
          provider: "sktech",
          stream: { name: "✨ | support the project!", url: "https://cncverse.pages.dev" },
        },
        // Same stream differing ONLY by HTTP/HTTPS, default port, trailing slash, param order & rotating token -> MUST collapse & fuse headers
        {
          provider: "sportzx",
          stream: {
            name: "Star Sports 1 1080p",
            url: "http://cdn.example.net:80/live/ss1/master.m3u8/?a=1&hdnea=exp=100",
          },
        },
        {
          provider: "playztv",
          stream: {
            name: "Star Sports 1 1080p",
            url: "https://cdn.example.net:443/live/ss1/master.m3u8?hdnea=exp=200&a=1",
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: { Referer: "https://player.example.com/", "User-Agent": "CustomUA/1.0" } },
            },
          },
        },
        // Distinct camera angles on same feed -> MUST stay separate
        {
          provider: "livxow",
          stream: { name: "Willow Cricket Stump Cam 1080p", url: "https://cdn.example.net/live/willow.m3u8?cam=1" },
        },
        {
          provider: "livxow",
          stream: { name: "Willow Cricket Spider Cam 1080p", url: "https://cdn.example.net/live/willow.m3u8?cam=2" },
        },
        // Bridged DASH-to-HLS with maxh=396 AND "UNBEATEN FHD" label -> MUST report 396p, NOT 1080p!
        {
          provider: "playfy",
          stream: {
            name: "Direct 396p · ~0.5 Mbps · UNBEATEN FHD",
            url: `http://129.225.106.195/d/master.m3u8?d=${encodeURIComponent("https://cdn.aiv-cdn.net/m.mpd")}&maxh=396`,
          },
        },
        // Raw public IP origin HLS + extensionless contentfabric CDN -> MUST be preserved
        {
          provider: "sportzx",
          stream: { name: "PTV Sports 720p", url: "http://193.47.62.59/hls/RREGEGEAA.m3u8" },
        },
        {
          provider: "playztv",
          stream: {
            name: "World Feed 1080p",
            url: "https://host-1.contentfabric.io/q/iq__abc123/rep/playout/default/hls-clear/playlist",
          },
        },
        // Load-bearing `cid` param -> MUST stay separate
        {
          provider: "sktech",
          stream: { name: "Ten Sports 1", url: "https://edge.example.net/play.m3u8?cid=101" },
        },
        {
          provider: "sktech",
          stream: { name: "Ten Sports 2", url: "https://edge.example.net/play.m3u8?cid=102" },
        },
      ],
      "https://api.playon.dev"
    );

    expect(audit.excludedCount).toBe(2);
    // 1 (collapsed Star Sports) + 2 (stump/spider cam) + 1 (396p bridged) + 1 (raw IP) + 1 (contentfabric) + 2 (cid) = 8
    expect(streams.length).toBe(8);

    // Header fusion onto collapsed primary
    const ss1 = streams.find((s) => s.broadcaster === "Star Sports 1");
    expect(ss1?.providers).toEqual(["playztv", "sportzx"]);
    expect(ss1?.mirrors.length).toBe(1);
    expect(ss1?.headers?.Referer ?? ss1?.headers?.referer).toBe("https://player.example.com/");
    expect(ss1?.needsProxy).toBe(true);

    // Camera angles preserved distinctly
    const cams = streams.filter((s) => s.cameraAngle !== null).map((s) => s.cameraAngle).sort();
    expect(cams).toEqual(["spider_cam", "stump_cam"]);

    // Truthful 396p quality (never inflated to 1080p by "FHD" text)
    const bridged396 = streams.find((s) => s.url.includes("maxh=396"));
    expect(bridged396?.quality).toBe("396p");
    expect(bridged396?.height).toBe(396);

    // Raw IP & extensionless contentfabric preserved
    expect(streams.some((s) => s.url.includes("193.47.62.59"))).toBe(true);
    expect(streams.some((s) => s.url.includes("contentfabric.io"))).toBe(true);
  });

  it("overrides inflated fake provider quality labels (e.g. 4K) with verified HLS manifest truth (480p)", () => {
    const { streams } = StreamEngine.deduplicateAndRank(
      [
        {
          provider: "sportzx",
          stream: {
            name: "Fake 4K UHD Super Stream",
            title: "4K 2160p HDR",
            url: "https://cdn.example.net/live/fake4k.m3u8",
          },
        },
      ],
      "https://api.playon.dev"
    );
    expect(streams[0]?.quality).toBe("4K");

    const target = streams[0]!;
    StreamEngine.applyHlsProbe(target, {
      verified: true,
      isLive: true,
      maxHeight: 480,
      maxBitrateBps: 1_200_000,
      renditions: [
        {
          quality: "480p",
          width: 854,
          height: 480,
          bitrateBps: 1_200_000,
          fps: 30,
          codecs: "avc1.4d401f,mp4a.40.2",
          url: "https://cdn.example.net/live/480p.m3u8",
        },
      ],
    });

    expect(target.hlsVerified).toBe(true);
    expect(target.quality).toBe("480p");
    expect(target.height).toBe(480);
    expect(target.bitrateBps).toBe(1_200_000);
    expect(target.codecs).toBe("avc1.4d401f,mp4a.40.2");
  });
});
