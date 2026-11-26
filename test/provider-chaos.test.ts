import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPosterParams, parseDateTimeMs } from "../src/domain/normalizer";
import { buildCatalogSnapshot } from "../src/domain/reconciliation";
import { decodeCncRawId } from "../src/domain/cnc";
import { Aggregator } from "../src/edge/aggregator";
import { UpstreamClient } from "../src/edge/upstream";
import type { UpstreamMeta } from "../src/types";

function encodeSingleColon(prefix: string, data: object): string {
  const raw = `${prefix}:${JSON.stringify(data)}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `cnc:${btoa(bin)}`;
}

function encodeDoubleColon(prefix: string, data: object): string {
  const raw = `${prefix}::${JSON.stringify(data)}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `cnc:${btoa(bin)}`;
}

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

describe("Real Upstream Chaos & Provider Parser Truth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes both SportzX single-colon (:) and PlayZTV/LivXow/SKTech/PlayFy double-colon (::) payloads losslessly", () => {
    const sportzxId = encodeSingleColon("SportzXLiveEvents", {
      eventId: "szx_1",
      title: "India A vs U.A.E",
      cat: "Cricket",
      formats: [{ title: "Willow Cricket HD" }],
      eventInfo: {
        teamA: "India A",
        teamB: "U.A.E",
        eventName: "Men&#39;s Asia Cup Rising Stars &amp; Live",
        startTime: "2026-11-24T10:00:00Z",
        isLive: true,
      },
    });
    const playztvId = encodeDoubleColon("PlayZTVLiveEvents", {
      eventId: "pztv_1",
      title: "India A vs United Arab Emirates",
      cat: "Cricket",
      formats: [{ title: "PTV Sports 720p" }],
      eventInfo: {
        teamA: "India A",
        teamB: "United Arab Emirates",
        eventName: "Men's Asia Cup Rising Stars",
        startTime: "2026-11-24T10:00:00Z",
        isLive: true,
      },
    });

    const decSzx = decodeCncRawId(sportzxId);
    const decPztv = decodeCncRawId(playztvId);
    expect(decSzx?.data?.cat).toBe("Cricket");
    expect(decSzx?.data?.eventInfo?.teamA).toBe("India A");
    const firstFmt = decSzx?.data?.formats?.[0];
    expect(typeof firstFmt === "object" ? firstFmt.title : firstFmt).toBe("Willow Cricket HD");
    expect(decPztv?.data?.eventInfo?.teamB).toBe("United Arab Emirates");

    // Reconcile both providers into 1 unified event with decoded HTML entities
    const snap = buildCatalogSnapshot(
      [
        {
          provider: "sportzx",
          name: "SportzX",
          items: [{ id: sportzxId, type: "tv", name: "India A vs U.A.E" }],
          rawCount: 1,
          exclusions: [],
          healthy: true,
        },
        {
          provider: "playztv",
          name: "PlayZ TV",
          items: [{ id: playztvId, type: "tv", name: "India A vs United Arab Emirates" }],
          rawCount: 1,
          exclusions: [],
          healthy: true,
        },
      ],
      NOW
    );

    expect(snap.events.length).toBe(1);
    expect(snap.events[0]?.providerCount).toBe(2);
    expect(snap.events[0]?.title).toBe("India A vs United Arab Emirates");
    expect(snap.events[0]?.competition.name).not.toContain("&#39;");
    expect(snap.events[0]?.competition.name).not.toContain("&amp;");
    expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
  });

  it("rejects 200 OK HTML donation/challenge pages immediately, cancels body, and fails over to healthy host", async () => {
    let htmlBodyCancelled = false;
    const htmlStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<!DOCTYPE html><html><body>Monthly Support Goal</body></html>"));
      },
      cancel() {
        htmlBodyCancelled = true;
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://bad-html.example")) {
        return new Response(htmlStream, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ metas: [{ id: "ok_1", name: "Healthy Match" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new UpstreamClient(["https://bad-html.example", "https://good-json.example"]);
    const res = (await client.fetchJson("/catalog/tv/cnc_SportzXLiveEvents_tv.json")) as { metas: UpstreamMeta[] };
    expect(res.metas.length).toBe(1);
    expect(res.metas[0]?.id).toBe("ok_1");
    expect(htmlBodyCancelled).toBe(true);
    expect(client.getHostHealth()[0]?.failures).toBeGreaterThanOrEqual(1);
  });

  it("survives empty bodies, truncated JSON, null metas, and partial provider outages with zero unmapped items", async () => {
    const validId = encodeDoubleColon("LivXowLiveEvents", {
      title: "Arsenal vs Chelsea",
      cat: "Football",
      eventInfo: {
        teamA: "Arsenal",
        teamB: "Chelsea",
        eventName: "Premier League",
        startTime: "2026-11-24T13:00:00Z",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("SportzX")) {
        return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("PlayZTV")) {
        return new Response('{"metas": [{"id": "trunc', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("Cricify")) {
        return new Response(JSON.stringify({ metas: [] }), { status: 200 });
      }
      if (url.includes("LivXow")) {
        return new Response(
          JSON.stringify({
            metas: [
              null,
              { id: "", name: "Missing ID" },
              { id: validId, type: "tv", name: "Arsenal vs Chelsea" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("upstream error", { status: 502 });
    });

    const agg = new Aggregator(new UpstreamClient(["https://single-upstream.example"]));
    const snap = await agg.getSnapshot();
    expect(snap.degraded).toBe(true);
    expect(snap.events.length).toBe(1);
    expect(snap.events[0]?.title).toBe("Arsenal vs Chelsea");
    expect(snap.reconciliation.summary.unmappedRawItemsCount).toBe(0);
    // Excluded null & empty-id items must be explicitly accounted for, never silently dropped
    const livxowAcc = snap.reconciliation.providerAccounting.find((p) => p.provider === "livxow");
    expect(livxowAcc?.rawPayloadCount).toBe(3);
    expect(livxowAcc?.validItemsCount).toBe(1);
    expect(livxowAcc?.excludedItemsCount).toBe(2);
    expect(livxowAcc?.mappedCount).toBe(1);
  });

  it("extracts real card.cncverse.dpdns.org poster parameters (teamAImg/teamBImg/eventLogo=null/title=competition/isEnded)", () => {
    const poster =
      "https://card.cncverse.dpdns.org/card?title=ICC+World+Test+Championship&teamA=South+Africa&teamB=Bangladesh" +
      "&teamAImg=https%3A%2F%2Fimg.example.com%2Fsa.png&teamBImg=https%3A%2F%2Fimg.example.com%2Fban.png" +
      "&eventLogo=null&isLive=false&isEnded=true&startTime=1795521600";

    const parsed = extractPosterParams(poster);
    expect(parsed).not.toBeNull();
    expect(parsed?.tournament).toBe("ICC World Test Championship");
    expect(parsed?.title).toBeNull();
    expect(parsed?.teamA).toBe("South Africa");
    expect(parsed?.teamB).toBe("Bangladesh");
    expect(parsed?.teamALogo).toBe("https://img.example.com/sa.png");
    expect(parsed?.teamBLogo).toBe("https://img.example.com/ban.png");
    expect(parsed?.competitionLogo).toBeNull(); // Literal "null" must be filtered
    expect(parsed?.isLive).toBe(false);
    expect(parsed?.isEnded).toBe(true);
    expect(parseDateTimeMs(parsed?.startTimeRaw)).toBe(1795521600 * 1000);
    // Epoch ms vs epoch sec parity
    expect(parseDateTimeMs(1795521600000)).toBe(1795521600000);
  });
});
