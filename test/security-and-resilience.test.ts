import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCncRawId, MAX_CNC_RAW_ID_LENGTH } from "../src/domain/cnc";
import { EdgeCache } from "../src/edge/cache";
import { MAX_PLAYLIST_BYTES, StreamProxy } from "../src/edge/proxy";
import { EdgeTelemetry } from "../src/edge/telemetry";
import { mapWithConcurrency, UpstreamClient } from "../src/edge/upstream";
import { createApp } from "../src/index";

describe("Security & Edge Resilience Hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks all private/reserved IPv4, IPv6, encoded IP, credential, and internal host targets", () => {
    const blocked = [
      "file:///etc/passwd",
      "ftp://cdn.example.com/a.m3u8",
      "http://user:pass@cdn.example.com/a.m3u8",
      "http://localhost/live.m3u8",
      "http://localhost./live.m3u8",
      "http://sub.localhost/live.m3u8",
      "http://service.internal/live.m3u8",
      "http://printer.local/live.m3u8",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://127.0.0.1/a.m3u8",
      "http://127.1/a.m3u8",
      "http://0177.0.0.1/a.m3u8",
      "http://0x7f000001/a.m3u8",
      "http://2130706433/a.m3u8",
      "http://0.0.0.0/a.m3u8",
      "http://10.0.0.1/a.m3u8",
      "http://100.64.0.1/a.m3u8",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.16.0.1/a.m3u8",
      "http://192.168.1.1/a.m3u8",
      "http://198.18.0.1/a.m3u8",
      "http://224.0.0.1/a.m3u8",
      "http://240.0.0.1/a.m3u8",
      "http://[::1]/a.m3u8",
      "http://[::]/a.m3u8",
      "http://[::ffff:127.0.0.1]/a.m3u8",
      "http://[::ffff:169.254.169.254]/a.m3u8",
      "http://[fe80::1]/a.m3u8",
      "http://[fe80::1%25eth0]/a.m3u8",
      "http://[fc00::1]/a.m3u8",
      "http://[fd12:3456::1]/a.m3u8",
      "http://[ff02::1]/a.m3u8",
      "http://[64:ff9b::169.254.169.254]/a.m3u8",
      "http://[2002:7f00:0001::1]/a.m3u8",
    ];
    for (const url of blocked) {
      expect(StreamProxy.isSafeTargetUrl(url), `expected blocked: ${url}`).toBe(false);
    }

    expect(StreamProxy.isSafeTargetUrl("https://cdn.example.net/live/master.m3u8")).toBe(true);
    expect(StreamProxy.isSafeTargetUrl("https://8.8.8.8/live.m3u8")).toBe(true);
  });

  it("enforces PROXY_ALLOWED_HOSTS exact and wildcard subdomain allowlists", () => {
    const allow = "cdn.example.com, *.stream-edge.net";
    expect(StreamProxy.isSafeTargetUrl("https://cdn.example.com/a.m3u8", allow)).toBe(true);
    expect(StreamProxy.isSafeTargetUrl("https://eu1.stream-edge.net/a.m3u8", allow)).toBe(true);
    expect(StreamProxy.isSafeTargetUrl("https://evil-stream-edge.net/a.m3u8", allow)).toBe(false);
    expect(StreamProxy.isSafeTargetUrl("https://other.org/a.m3u8", allow)).toBe(false);
  });

  it("blocks redirect-chain private destinations, rejects CRLF/oversized headers, strips Set-Cookie, and enforces 2 MiB M3U8 cap", async () => {
    const { app } = createApp();

    // 1. Redirect to metadata IP -> 403
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } })
    );
    const redirRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fstart.m3u8")
    );
    expect(redirRes.status).toBe(403);

    // 2. CRLF header injection & >512B header -> 400
    const crlfRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fa.ts&referer=https%3A%2F%2Fa.com%0D%0AX-Evil%3A1")
    );
    expect(crlfRes.status).toBe(400);

    const longHeaderRes = await app.fetch(
      new Request(`https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fa.ts&ua=${"x".repeat(520)}`)
    );
    expect(longHeaderRes.status).toBe(400);

    // 3. Strips Set-Cookie & CSP from upstream response
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "video/mp2t",
          "Set-Cookie": "session=secret; HttpOnly",
          "Content-Security-Policy": "default-src 'none'",
        },
      })
    );
    const segRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fseg.ts")
    );
    expect(segRes.status).toBe(200);
    expect(segRes.headers.get("Set-Cookie")).toBeNull();
    expect(segRes.headers.get("Content-Security-Policy")).toBeNull();

    // 4. Oversized M3U8 (> 2 MiB) -> 413 + stream cancelled
    let cancelled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(hugeStream, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      })
    );
    const hugeRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhuge.m3u8")
    );
    expect(hugeRes.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(MAX_PLAYLIST_BYTES).toBe(2 * 1024 * 1024);
  });

  it("rewrites all HLS tag URIs and never proxies private targets embedded inside playlists", () => {
    const m3u8 = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/k.key"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="En",URI="aud.m3u8"',
      '#EXT-X-PART:DURATION=1.0,URI="part1.m4s"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part2.m4s"',
      "http://169.254.169.254/secret.ts",
      "seg_0.ts",
    ].join("\n");

    const out = StreamProxy.rewriteM3u8Playlist(
      m3u8,
      "https://cdn.example.net/live/master.m3u8",
      "https://api.playon.dev",
      { referer: "https://player.example.com" }
    );

    expect(out).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fkeys%2Fk.key');
    expect(out).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Finit.mp4');
    expect(out).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Faud.m3u8');
    expect(out).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fpart1.m4s');
    expect(out).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fpart2.m4s');
    expect(out).toContain("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fseg_0.ts");
    // Unsafe embedded URI MUST NOT be wrapped in proxy
    expect(out).not.toContain("api/proxy?url=http%3A%2F%2F169.254.169.254");
  });

  it("enforces single-probe half-open circuit breaker, bounded concurrency, L1 byte budget, and collision-proof keys", async () => {
    // 1. Bounded concurrency <= 4
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 16 }, (_, i) => i), 4, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(4);

    // 2. Single-probe half-open circuit breaker
    vi.useFakeTimers();
    try {
      const client = new UpstreamClient(["https://single-host.example.net"]);
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

      for (let i = 0; i < 3; i++) {
        await expect(client.fetchJson(`/fail-${i}`)).rejects.toThrow();
      }
      expect(client.getHostHealth()[0]?.state).toBe("open");

      // Advance past 30s cooldown -> half-open allows strictly ONE concurrent probe
      vi.advanceTimersByTime(31_000);
      let resolveProbe!: (v: Response) => void;
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        () => new Promise<Response>((r) => { resolveProbe = r; })
      );

      const p1 = client.fetchJson("/probe-1");
      const p2 = client.fetchJson("/probe-2");
      await expect(p2).rejects.toThrow(/Circuit open/);
      resolveProbe(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await expect(p1).resolves.toEqual({ ok: true });
      expect(client.getHostHealth()[0]?.state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }

    // 3. L1 byte budget & collision-proof cache keys (UTF-16 accounted: ~820B per 400-char entry)
    const cache = new EdgeCache(100, 1800, 1000);
    const req = new Request("https://api.playon.dev/api/events");
    cache.putJson("k1", req, { d: "a".repeat(400) }, 60, 30);
    cache.putJson("k2", req, { d: "b".repeat(400) }, 60, 30);
    cache.putJson("k3", req, { d: "c".repeat(400) }, 60, 30);
    expect(cache.getStats().bytes).toBeLessThanOrEqual(1800);
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(1);

    const kA = EdgeCache.buildKey("events", { a: "1|b=2" });
    const kB = EdgeCache.buildKey("events", { a: "1", b: "2" });
    expect(kA).not.toBe(kB);
  });

  it("handles single-pass decoding, prototype-safe lookups, 16 KiB rawId cap, 404 telemetry isolation, and no-store on outage", async () => {
    // 16 KiB decodeCncRawId DoS cap
    const giant = `cnc:${"A".repeat(MAX_CNC_RAW_ID_LENGTH + 10)}`;
    expect(decodeCncRawId(giant)).toBeNull();

    // 404 scanner isolation
    const telemetry = new EdgeTelemetry();
    telemetry.record("/wp-admin/install.php", 404, 1.2);
    telemetry.record("/.env", 404, 0.8);
    const snap = telemetry.snapshot();
    expect(Object.keys(snap.routes)).toEqual(["/* (unmatched)"]);
    expect(snap.routes["/* (unmatched)"]?.requests).toBe(2);

    // Outage returns 503 with Cache-Control: no-store
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("upstream down"));
    const { app } = createApp();
    const outage = await app.fetch(new Request("https://api.playon.dev/api/events"));
    expect(outage.status).toBe(503);
    expect(outage.headers.get("Cache-Control")).toBe("no-store");

    // Malformed percent encoding -> 400; valid encoded 100%25 -> not double-decoded (503/404, never crash)
    const badPct = await app.fetch(new Request("https://api.playon.dev/api/events/%E0%A4%A"));
    expect(badPct.status).toBe(400);

    // Prototype-safe sport/team queries never throw
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ metas: [] }), { status: 200 })
    );
    const { app: app2 } = createApp();
    const protoRes = await app2.fetch(
      new Request("https://api.playon.dev/api/events?sport=constructor&team=__proto__")
    );
    expect(protoRes.status).toBe(200);
    const doubleEnc = await app2.fetch(new Request("https://api.playon.dev/api/events/100%25"));
    expect(doubleEnc.status).toBe(404);
  });

  it("supports video player Range 206 passthrough, CORS preflight/expose headers, M3U8 Content-Length stripping, and root-relative/I-FRAME rewrites", async () => {
    const { app } = createApp();

    // 1. OPTIONS /api/proxy preflight allows Range & Origin
    const optRes = await app.fetch(new Request("https://api.playon.dev/api/proxy", { method: "OPTIONS" }));
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get("Access-Control-Allow-Headers")).toContain("Range");
    expect(optRes.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");

    // 2. Range request on binary segment -> 206 Partial Content preserving Content-Length, Content-Range, Accept-Ranges
    const rangeBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(rangeBytes, {
        status: 206,
        headers: {
          "Content-Type": "video/mp2t",
          "Content-Length": "4",
          "Content-Range": "bytes 0-3/1024",
          "Accept-Ranges": "bytes",
        },
      })
    );
    const partialRes = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fseg0.ts", {
        headers: { Range: "bytes=0-3" },
      })
    );
    expect(partialRes.status).toBe(206);
    expect(partialRes.headers.get("Content-Length")).toBe("4");
    expect(partialRes.headers.get("Content-Range")).toBe("bytes 0-3/1024");
    expect(partialRes.headers.get("Accept-Ranges")).toBe("bytes");
    expect(partialRes.headers.get("Access-Control-Expose-Headers")).toContain("Content-Length");
    expect(partialRes.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    const forwardedInit = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(forwardedInit?.headers).get("Range")).toBe("bytes=0-3");
    expect(new Uint8Array(await partialRes.arrayBuffer())).toEqual(rangeBytes);

    // 3. Rewritten M3U8 strips upstream Content-Length/Content-Encoding and rewrites root-relative + I-FRAME + blocks scheme bypass
    const playlist = [
      "#EXTM3U",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=800000,URI="/iframes/v1.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="En",URI="/audio/eng.m3u8"',
      "http:169.254.169.254/secret.ts",
      "/segments/seg1.ts",
    ].join("\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(playlist, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Length": String(playlist.length),
          "Content-Encoding": "gzip",
        },
      })
    );
    const m3u8Res = await app.fetch(
      new Request("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Flive%2Fmaster.m3u8")
    );
    expect(m3u8Res.status).toBe(200);
    expect(m3u8Res.headers.get("Content-Length")).toBeNull();
    expect(m3u8Res.headers.get("Content-Encoding")).toBeNull();
    const rewritten = await m3u8Res.text();
    expect(rewritten).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fiframes%2Fv1.m3u8"');
    expect(rewritten).toContain('URI="https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Faudio%2Feng.m3u8"');
    expect(rewritten).toContain("https://api.playon.dev/api/proxy?url=https%3A%2F%2Fcdn.example.net%2Fsegments%2Fseg1.ts");
    expect(rewritten).not.toContain("api/proxy?url=http%3A%2F%2F169.254.169.254");
    expect(rewritten).not.toContain("api/proxy?url=http%3A169.254.169.254");
  });

  it("aborts losing hedged fetch when winning host resolves first", async () => {
    vi.useFakeTimers();
    try {
      let hedgeSignalAborted = false;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://primary.example")) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 })), 700);
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            hedgeSignalAborted = true;
            reject(new Error("aborted"));
          });
        });
      });

      const client = new UpstreamClient(["https://primary.example", "https://secondary.example"]);
      const p = client.fetchJson("/catalog/tv/test.json");
      await vi.advanceTimersByTimeAsync(750);
      await expect(p).resolves.toEqual({ ok: 1 });
      expect(hedgeSignalAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
