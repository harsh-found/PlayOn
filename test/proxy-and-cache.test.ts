import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCncRawId } from "../src/domain/cnc";
import { computeWeakEtag, EdgeCache, matchesIfNoneMatch } from "../src/edge/cache";
import { MAX_PLAYLIST_BYTES, StreamProxy } from "../src/edge/proxy";
import { UpstreamClient } from "../src/edge/upstream";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("StreamProxy, EdgeCache & UpstreamClient — Security & Resilience", () => {
  it("blocks IPv4 private, loopback, CGNAT, link-local, multicast, doc, octal, hex, and integer SSRF encodings", () => {
    const blocked = [
      "http://127.0.0.1/live.m3u8",
      "http://10.0.0.1/live.m3u8",
      "http://172.16.5.1/live.m3u8",
      "http://192.168.1.10/live.m3u8",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/cgnat.m3u8",
      "http://224.0.0.1/multicast.m3u8",
      "http://198.51.100.5/doc.m3u8",
      "http://0177.0.0.1/octal.m3u8",
      "http://0x7f000001/hex.m3u8",
      "http://2130706433/int.m3u8",
    ];
    for (const u of blocked) expect(StreamProxy.isSafeTargetUrl(u), u).toBe(false);
    expect(StreamProxy.isSafeTargetUrl("https://cdn.example.net/live/stream.m3u8")).toBe(true);
  });

  it("blocks IPv6 loopback, ULA, link-local, IPv4-mapped SSRF, userinfo, and internal hostname suffixes", () => {
    const blocked = [
      "http://[::1]/live.m3u8",
      "http://[fc00::1]/live.m3u8",
      "http://[fe80::1]/live.m3u8",
      "http://[::ffff:127.0.0.1]/live.m3u8",
      "http://[::ffff:169.254.169.254]/meta",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://service.localhost/stream.m3u8",
      "http://router.local/stream.m3u8",
      "http://db.internal/stream.m3u8",
      "https://user:pass@cdn.example.net/live.m3u8",
      "file:///etc/passwd",
    ];
    for (const u of blocked) expect(StreamProxy.isSafeTargetUrl(u), u).toBe(false);
  });

  it("enforces PROXY_ALLOWED_HOSTS exact and wildcard allowlist policies accurately", () => {
    const allow = "cdn.example.net, *.akamaized.net";
    expect(StreamProxy.isSafeTargetUrl("https://cdn.example.net/a.m3u8", allow)).toBe(true);
    expect(StreamProxy.isSafeTargetUrl("https://live.akamaized.net/a.m3u8", allow)).toBe(true);
    expect(StreamProxy.isSafeTargetUrl("https://akamaized.net/a.m3u8", allow)).toBe(false);
    expect(StreamProxy.isSafeTargetUrl("https://evil.example.org/a.m3u8", allow)).toBe(false);
  });

  it("rewrites all HLS tag URI attributes, relative/root/protocol-relative/parent paths, and skips private URIs", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="/global/s.key"',
      '#EXT-X-MAP:URI="../init/seg0.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",URI="//audio.example.net/hin/audio.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframes.m3u8"',
      '#EXT-X-PART:DURATION=0.5,URI="part1.m4s"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="http://127.0.0.1/secret.m4s"',
      "#EXTINF:4.0,",
      "seg001.ts?token=abc",
    ].join("\n");

    const out = StreamProxy.rewriteM3u8Playlist(
      playlist,
      "https://cdn.example.net/live/match1/master.m3u8",
      "https://edge.playon.dev",
      { referer: "https://player.example.com/", origin: "https://player.example.com", ua: "TestUA/1.0" }
    );

    expect(out).toContain('URI="https://edge.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fmatch1%2Fkeys%2Fenc.key');
    expect(out).toContain("rewrite=false");
    expect(out).toContain("referer=https%3A%2F%2Fplayer.example.com%2F");
    expect(out).toContain("origin=https%3A%2F%2Fplayer.example.com");
    expect(out).toContain("ua=TestUA%2F1.0");
    expect(out).toContain(encodeURIComponent("https://cdn.example.net/global/s.key"));
    expect(out).toContain(encodeURIComponent("https://cdn.example.net/live/init/seg0.mp4"));
    expect(out).toContain(encodeURIComponent("https://audio.example.net/hin/audio.m3u8"));
    // Sub-playlists must NOT have rewrite=false
    const mediaLine = out.split("\n").find((l) => l.startsWith("#EXT-X-MEDIA:")) ?? "";
    expect(mediaLine).not.toContain("rewrite=false");
    // Private IP URI must NOT be proxied
    expect(out).toContain('URI="http://127.0.0.1/secret.m4s"');
  });

  it("rejects missing url (400), blocked SSRF url (403), and CRLF/oversized header overrides (400)", async () => {
    const rMissing = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy"));
    expect(rMissing.status).toBe(400);
    expect((await rMissing.json() as { code: string }).code).toBe("MISSING_TARGET_URL");

    const rBlocked = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=http://169.254.169.254/latest"));
    expect(rBlocked.status).toBe(403);

    const rCrlf = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/a.m3u8&referer=https://a.com%0d%0aX-Injected:1"));
    expect(rCrlf.status).toBe(400);
    expect((await rCrlf.json() as { code: string }).code).toBe("INVALID_PROXY_HEADER");

    const rTooLong = await StreamProxy.handleProxyRequest(new Request(`https://edge.test/api/proxy?url=https://cdn.example.net/a.m3u8&ua=${"a".repeat(600)}`));
    expect(rTooLong.status).toBe(400);
  });

  it("passes valid Range headers, drops malformed Range headers, and strips Set-Cookie/CSP/X-Frame-Options", async () => {
    const seenRanges: Array<string | null> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenRanges.push(new Headers(init?.headers).get("Range"));
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp2t",
          "Content-Range": "bytes 0-3/100",
          "Set-Cookie": "sid=secret",
          "Content-Security-Policy": "default-src 'none'",
          "X-Frame-Options": "SAMEORIGIN",
        },
      });
    }) as typeof fetch;

    const rOk = await StreamProxy.handleProxyRequest(
      new Request("https://edge.test/api/proxy?url=https://cdn.example.net/seg.ts&rewrite=false", {
        headers: { Range: "bytes=0-3" },
      })
    );
    expect(rOk.status).toBe(206);
    expect(rOk.headers.get("Set-Cookie")).toBeNull();
    expect(rOk.headers.get("Content-Security-Policy")).toBeNull();
    expect(rOk.headers.get("X-Frame-Options")).toBe("DENY");

    await StreamProxy.handleProxyRequest(
      new Request("https://edge.test/api/proxy?url=https://cdn.example.net/seg.ts&rewrite=false", {
        headers: { Range: "items=0-3; evil" },
      })
    );
    expect(seenRanges).toEqual(["bytes=0-3", null]);
  });

  it("blocks redirect-to-private-IP (403) and terminates infinite redirect loops (502)", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret.m3u8" } })) as typeof fetch;
    const rSsrf = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/a.m3u8"));
    expect(rSsrf.status).toBe(403);
    expect((await rSsrf.json() as { code: string }).code).toBe("REDIRECT_TARGET_BLOCKED");

    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/loop.m3u8" } })) as typeof fetch;
    const rLoop = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/loop.m3u8"));
    expect(rLoop.status).toBe(502);
    expect((await rLoop.json() as { code: string }).code).toBe("REDIRECT_LIMIT_EXCEEDED");
  });

  it("returns 413 PLAYLIST_TOO_LARGE on both declared Content-Length and streaming chunked overflow", async () => {
    globalThis.fetch = (async () => new Response("#EXTM3U\n", {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": String(MAX_PLAYLIST_BYTES + 1024) },
    })) as typeof fetch;
    const rDecl = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/big.m3u8"));
    expect(rDecl.status).toBe(413);

    globalThis.fetch = (async () => {
      const chunk = new Uint8Array(512 * 1024).fill(65);
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (let i = 0; i < 6; i++) ctrl.enqueue(chunk);
          ctrl.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    }) as typeof fetch;
    const rStream = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/chunked.m3u8"));
    expect(rStream.status).toBe(413);
  });

  it("evicts L1 EdgeCache entries by both maxEntries count and maxBytes budget with accurate stats", () => {
    const cache = new EdgeCache(2, 320, 280);
    const req = new Request("https://edge.test/api/events");

    cache.putRawJson("k1", req, JSON.stringify({ a: "1234567890" }), 60, 30);
    cache.putRawJson("k2", req, JSON.stringify({ b: "1234567890" }), 60, 30);
    // Touch k1 so k2 becomes LRU
    expect(cache.getL1Sync("k1", req)?.headers.get("X-Cache")).toBe("HIT-L1");
    cache.putRawJson("k3", req, JSON.stringify({ c: "1234567890" }), 60, 30);

    expect(cache.getL1Sync("k2", req)).toBeNull();
    expect(cache.getL1Sync("k1", req)).not.toBeNull();
    expect(cache.getL1Sync("k3", req)).not.toBeNull();
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(1);

    // Byte budget eviction: store a ~250-byte UTF-16 entry when maxBytes is 320
    cache.putRawJson("big", req, JSON.stringify({ payload: "x".repeat(110) }), 60, 30);
    expect(cache.getStats().bytes).toBeLessThanOrEqual(320);
  });

  it("expires stale L1 entries past TTL and supports weak/strong/wildcard/multi-tag ETag matching", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const cache = new EdgeCache();
    const req = new Request("https://edge.test/api/events");
    cache.putRawJson("ttl-k", req, '{"ok":true}', 10, 5);
    expect(cache.getL1Sync("ttl-k", req)).not.toBeNull();
    nowSpy.mockReturnValue(2_015_000);
    expect(cache.getL1Sync("ttl-k", req)).toBeNull();

    const etag = computeWeakEtag('{"ok":true}');
    expect(etag).toBe(computeWeakEtag('{"ok":true}'));
    expect(computeWeakEtag(new TextEncoder().encode('{"ok":true}'))).toMatch(/^W\/"[0-9a-f]+-b"$/);
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
    expect(matchesIfNoneMatch(etag.slice(2), etag)).toBe(true);
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
    expect(matchesIfNoneMatch(`"other", ${etag}, "third"`, etag)).toBe(true);
    expect(matchesIfNoneMatch('"mismatch"', etag)).toBe(false);
    expect(matchesIfNoneMatch(null, etag)).toBe(false);
  });

  it("prevents EdgeCache.buildKey collisions via length-prefixed serialization", () => {
    const k1 = EdgeCache.buildKey("events", { a: "x|b=y" });
    const k2 = EdgeCache.buildKey("events", { a: "x", b: "y" });
    expect(k1).not.toBe(k2);
  });

  it("opens UpstreamClient circuit breaker after 3 failures and transitions cleanly to half-open after cooldown", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("Server Error", { status: 500 });
    }) as typeof fetch;

    const client = new UpstreamClient(["https://primary.example.test"]);
    for (let i = 0; i < 3; i++) {
      await expect(client.fetchCatalog("sportzx", "cat1")).rejects.toThrow();
    }
    expect(client.getHostHealth()[0]?.state).toBe("open");
    expect(calls).toBe(3);

    // Immediate call while open must fail fast without calling fetch
    await expect(client.fetchCatalog("sportzx", "cat1")).rejects.toThrow();
    expect(calls).toBe(3);

    // Advance past 30s cooldown -> half-open probe succeeds and closes breaker
    nowSpy.mockReturnValue(1_035_000);
    expect(client.getHostHealth()[0]?.state).toBe("half-open");
    globalThis.fetch = (async () => new Response(JSON.stringify({ metas: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const res = await client.fetchCatalog("sportzx", "cat1");
    expect(res.items).toEqual([]);
    expect(client.getHostHealth()[0]?.state).toBe("closed");
  });

  it("rejects Cloudflare HTML challenge pages and truncated JSON in UpstreamClient", async () => {
    globalThis.fetch = (async () =>
      new Response("<!DOCTYPE html><html>Just a moment...</html>", { status: 200, headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const client = new UpstreamClient(["https://cf-challenge.example.test"]);
    await expect(client.fetchCatalog("sportzx", "cat1")).rejects.toThrow();

    globalThis.fetch = (async () =>
      new Response('{"metas":[{"id":"trunc', { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const client2 = new UpstreamClient(["https://trunc.example.test"]);
    await expect(client2.fetchCatalog("sportzx", "cat1")).rejects.toThrow();
  });

  it("caches stream responses per rawId in UpstreamClient LRU and respects clearStreamCache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ streams: [{ url: "https://cdn.example.net/live.m3u8", name: "HD" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new UpstreamClient(["https://streams.example.test"]);
    const s1 = await client.fetchStreams("cnc:abc");
    const s2 = await client.fetchStreams("cnc:abc");
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(calls).toBe(1);

    client.clearStreamCache();
    await client.fetchStreams("cnc:abc");
    expect(calls).toBe(2);
  });

  it("decodes URL-safe unpadded Base64 CNC IDs and rejects oversized or malformed raw IDs", () => {
    const raw = `sportzx:${JSON.stringify({ title: "Atlético vs Barça" })}`;
    const b64url = btoa(String.fromCharCode(...new TextEncoder().encode(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = decodeCncRawId(`cnc:${b64url}`);
    expect(decoded?.provider).toBe("sportzx");
    expect(decoded?.data?.title).toBe("Atlético vs Barça");

    expect(decodeCncRawId("not-cnc:abc")).toBeNull();
    expect(decodeCncRawId("cnc:!!!not-base64!!!")).toBeNull();
    expect(decodeCncRawId(`cnc:${"A".repeat(20_000)}`)).toBeNull();
  });

  it("handles HEAD requests on /api/proxy without streaming a response body", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": "512" } });
    }) as typeof fetch;

    const res = await StreamProxy.handleProxyRequest(new Request("https://edge.test/api/proxy?url=https://cdn.example.net/live.m3u8", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Length")).toBe("512");
  });
});
