import { describe, expect, it } from "vitest";
import { ChannelNormalizer, ENGLISH_LANG } from "../src/domain/channel";
import { DrmDetector } from "../src/domain/drm";

describe("ChannelNormalizer & DrmDetector — Real-World Feeds", () => {
  it("normalizes Sky Sports sub-channels including Main Event, Cricket, F1, and Italia", () => {
    expect(ChannelNormalizer.normalize("Sky Sports Main Event HD")).toEqual({ name: "Sky Sports Main Event", group: "Sky Sports" });
    expect(ChannelNormalizer.normalize("Sky Sports Top Event FHD")).toEqual({ name: "Sky Sports Main Event", group: "Sky Sports" });
    expect(ChannelNormalizer.normalize("Sky Sports Cricket 1080p")).toEqual({ name: "Sky Sports Cricket", group: "Sky Sports" });
    expect(ChannelNormalizer.normalize("Sky Sports F1 UHD")).toEqual({ name: "Sky Sports F1", group: "Sky Sports" });
    expect(ChannelNormalizer.normalize("Sky Sport Italia")).toEqual({ name: "Sky Sport Italia", group: "Sky Sports" });
  });

  it("normalizes Sony Sports Ten 1-5, Sony Six legacy alias, Sony LIV, and Ten Sports", () => {
    expect(ChannelNormalizer.normalize("Sony Ten 1 HD")).toEqual({ name: "Sony Sports Ten 1", group: "Sony Sports Network" });
    expect(ChannelNormalizer.normalize("Sony Sports Ten 5")).toEqual({ name: "Sony Sports Ten 5", group: "Sony Sports Network" });
    expect(ChannelNormalizer.normalize("Sony Six HD")).toEqual({ name: "Sony Sports Ten 5", group: "Sony Sports Network" });
    expect(ChannelNormalizer.normalize("SonyLIV 1080p")).toEqual({ name: "Sony LIV", group: "Sony Sports Network" });
    expect(ChannelNormalizer.normalize("Ten Sports PK")).toEqual({ name: "Ten Sports HD", group: "Ten Sports" });
  });

  it("normalizes Star Sports 1/2/Hindi/Select and Willow Cricket/Xtra", () => {
    expect(ChannelNormalizer.normalize("Star Sports 1 Hindi HD")).toEqual({ name: "Star Sports 1 Hindi", group: "Star Sports" });
    expect(ChannelNormalizer.normalize("Star Sports Select 2")).toEqual({ name: "Star Sports Select 2", group: "Star Sports" });
    expect(ChannelNormalizer.normalize("Star Sports 2 HD")).toEqual({ name: "Star Sports 2", group: "Star Sports" });
    expect(ChannelNormalizer.normalize("Willow Cricket 1080p")).toEqual({ name: "Willow Cricket HD", group: "Willow" });
    expect(ChannelNormalizer.normalize("Willow Xtra HD")).toEqual({ name: "Willow Xtra", group: "Willow" });
  });

  it("normalizes SuperSport, beIN, ESPN+/2, Fox Cricket 501, and Kayo", () => {
    expect(ChannelNormalizer.normalize("SuperSport Premier League")).toEqual({ name: "SuperSport Premier League", group: "SuperSport" });
    expect(ChannelNormalizer.normalize("SuperSport Cricket HD")).toEqual({ name: "SuperSport Cricket", group: "SuperSport" });
    expect(ChannelNormalizer.normalize("beIN Sports 2")).toEqual({ name: "beIN Sports 2", group: "beIN Sports" });
    expect(ChannelNormalizer.normalize("ESPN+ Live")).toEqual({ name: "ESPN+", group: "ESPN" });
    expect(ChannelNormalizer.normalize("ESPN 2 HD")).toEqual({ name: "ESPN 2", group: "ESPN" });
    expect(ChannelNormalizer.normalize("Fox Cricket 501")).toEqual({ name: "Fox Cricket 501", group: "Fox Sports" });
    expect(ChannelNormalizer.normalize("Kayo Sports HD")).toEqual({ name: "Fox Sports HD", group: "Fox Sports" });
  });

  it("normalizes numbered networks (TNT/BT Sport, TSN, DAZN, Eurosport, SporTV) and streaming platforms", () => {
    expect(ChannelNormalizer.normalize("TNT Sports 1")).toEqual({ name: "TNT Sports 1", group: "TNT Sports" });
    expect(ChannelNormalizer.normalize("BT Sport 2 HD")).toEqual({ name: "TNT Sports 2", group: "TNT Sports" });
    expect(ChannelNormalizer.normalize("TSN 4 HD")).toEqual({ name: "TSN 4", group: "TSN" });
    expect(ChannelNormalizer.normalize("DAZN 1")).toEqual({ name: "DAZN 1 HD", group: "DAZN" });
    expect(ChannelNormalizer.normalize("Eurosport 2")).toEqual({ name: "Eurosport 2", group: "Eurosport" });
    expect(ChannelNormalizer.normalize("SporTV 2")).toEqual({ name: "SporTV 2", group: "SporTV" });
    expect(ChannelNormalizer.normalize("Amazon Prime Video Hindi")).toEqual({ name: "Amazon Prime Video", group: "Amazon Prime" });
    expect(ChannelNormalizer.normalize("Apple TV+ MLS")).toEqual({ name: "Apple TV+", group: "Apple TV+" });
    expect(ChannelNormalizer.normalize("Canal+ Sport")).toEqual({ name: "Canal+ Sport", group: "Canal+" });
    expect(ChannelNormalizer.normalize("ViX Deportes")).toEqual({ name: "ViX Deportes", group: "ViX" });
  });

  it("extracts broadcaster from multi-line 🏷️ titles and strips provider noise, bitrates, and spam trailers", () => {
    const noisy = "🏷️ Star Sports 1 Hindi HD 1080p ~5.2 Mbps (playztv) Join Telegram t.me/spam\n🛰️ playztv";
    expect(ChannelNormalizer.normalize("playztv", noisy)).toEqual({ name: "Star Sports 1 Hindi", group: "Star Sports" });

    const multiNoTag = "🔥 Live HD Stream\nSky Sports Main Event 1080p\nAudio: English";
    expect(ChannelNormalizer.normalize(undefined, multiNoTag)).toEqual({ name: "Sky Sports Main Event", group: "Sky Sports" });
  });

  it("falls back to URL broadcaster inference when title is a generic server label", () => {
    expect(ChannelNormalizer.normalize("Server 1", "HD Server 1", "https://slivcdn.com/live/1080.m3u8")).toEqual({
      name: "Sony LIV",
      group: "Sony Sports Network",
    });
    expect(ChannelNormalizer.normalize("Stream 2", "Direct 720p", "https://edge.fancode.com/hls/match.m3u8")).toEqual({
      name: "FanCode",
      group: "FanCode",
    });
    expect(ChannelNormalizer.normalize("Backup Server", "Low Quality", "https://msnetworks.net/ptv/live.m3u8")).toEqual({
      name: "PTV Sports",
      group: "PTV Sports",
    });
  });

  it("handles bare language labels and generic server names gracefully", () => {
    expect(ChannelNormalizer.normalize("Hindi HD 720p")).toEqual({ name: "Live Broadcast (Hindi)", group: "General Sports" });
    expect(ChannelNormalizer.normalize("SD Server 3")).toEqual({ name: "Standard Feed", group: "General Sports" });
    expect(ChannelNormalizer.normalize("Stream 1")).toEqual({ name: "Standard Feed", group: "General Sports" });
    expect(ChannelNormalizer.normalize("", "")).toEqual({ name: "Standard Feed", group: "General Sports" });
  });

  it("detects languages from regional flag emojis accurately", () => {
    expect(ChannelNormalizer.extractLanguage("🇪🇸 LaLiga TV").code).toBe("spa");
    expect(ChannelNormalizer.extractLanguage("🇧🇷 SporTV").code).toBe("por");
    expect(ChannelNormalizer.extractLanguage("🇫🇷 Canal+").code).toBe("fra");
    expect(ChannelNormalizer.extractLanguage("🇩🇪 Sky Sport").code).toBe("deu");
    expect(ChannelNormalizer.extractLanguage("🇮🇹 DAZN").code).toBe("ita");
    expect(ChannelNormalizer.extractLanguage("🇷🇺 Match TV").code).toBe("rus");
    expect(ChannelNormalizer.extractLanguage("🇸🇦 SSC 1").code).toBe("ara");
  });

  it("detects Indian broadcast languages and shorthand regional feed indicators", () => {
    expect(ChannelNormalizer.extractLanguage("Star Sports 1 Hindi").code).toBe("hin");
    expect(ChannelNormalizer.extractLanguage("Star Sports Tamil Feed").code).toBe("tam");
    expect(ChannelNormalizer.extractLanguage("JioCinema Telugu").code).toBe("tel");
    expect(ChannelNormalizer.extractLanguage("Kannada Commentary").code).toBe("kan");
    expect(ChannelNormalizer.extractLanguage("Bangla Live").code).toBe("ben");
    expect(ChannelNormalizer.extractLanguage("Malayalam HD").code).toBe("mal");
    expect(ChannelNormalizer.extractLanguage("Urdu Feed").code).toBe("urd");
    expect(ChannelNormalizer.extractLanguage("SporTV BR HD").code).toBe("por");
    expect(ChannelNormalizer.extractLanguage("Sport 1 DE").code).toBe("deu");
    expect(ChannelNormalizer.extractLanguage("Russia Feed 1080p").code).toBe("rus");
  });

  it("extracts language from URL path tokens and falls back to English when unmarked", () => {
    expect(ChannelNormalizer.extractLanguage("Server 1", "https://cdn.example.com/hls/hindi/master.m3u8").code).toBe("hin");
    expect(ChannelNormalizer.extractLanguage("Server 2", "https://cdn.example.com/live_spa_hd/index.m3u8").code).toBe("spa");
    expect(ChannelNormalizer.extractLanguage("Server 3", "https://cdn.example.com/pt-br/stream.m3u8").code).toBe("por");
    expect(ChannelNormalizer.extractLanguage("Sky Sports Main Event", "https://cdn.example.com/live/main.m3u8")).toEqual(ENGLISH_LANG);
  });

  it("extracts single and multi-key ClearKey DRM credentials from explicit field and query param", () => {
    const kid1 = "0123456789abcdef0123456789abcdef";
    const key1 = "fedcba9876543210fedcba9876543210";
    const kid2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const key2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const single = DrmDetector.detect("DASH 1080p", `${kid1}:${key1}`);
    expect(single).toEqual({ scheme: "clearkey", keys: [{ kid: kid1, key: key1 }] });

    const multi = DrmDetector.detect("DASH 1080p", undefined, `${kid1}:${key1},${kid2}:${key2}`);
    expect(multi?.scheme).toBe("clearkey");
    expect(multi?.keys).toHaveLength(2);
    expect(multi?.keys?.[1]).toEqual({ kid: kid2, key: key2 });
  });

  it("extracts inline ClearKey pairs embedded in stream labels or URLs and deduplicates identical keys", () => {
    const kid = "11112222333344445555666677778888";
    const key = "9999aaaabbbbccccddddeeeeffff0000";
    const res = DrmDetector.detect(`Sony DASH ${kid}:${key} https://cdn.example.com/a.mpd?clearkey=${kid}:${key}`);
    expect(res).toEqual({ scheme: "clearkey", keys: [{ kid, key }] });
  });

  it("detects Widevine DRM streams and returns null for clean non-DRM feeds", () => {
    expect(DrmDetector.detect("Widevine L3 DASH Stream")).toEqual({ scheme: "widevine" });
    expect(DrmDetector.detect("HLS 1080p Sky Sports Main Event")).toBeNull();
  });

  it("rejects malformed or short hex ClearKey strings instead of emitting broken keys", () => {
    const bad = DrmDetector.detect("clearkey stream", "1234:5678");
    expect(bad).toEqual({ scheme: "clearkey" });
    expect(bad?.keys).toBeUndefined();
    expect(DrmDetector.detect("normal stream", "not-hex:not-hex")).toBeNull();
  });

  it("preserves case-insensitive broadcaster matching on mixed-case and abbreviated labels", () => {
    expect(ChannelNormalizer.normalize("fancode 1080p")).toEqual({ name: "FanCode", group: "FanCode" });
    expect(ChannelNormalizer.normalize("nfl red zone")).toEqual({ name: "NFL RedZone", group: "NFL Network" });
    expect(ChannelNormalizer.normalize("nba league pass")).toEqual({ name: "NBA League Pass", group: "NBA TV" });
    expect(ChannelNormalizer.normalize("optus sport 1")).toEqual({ name: "Optus Sport", group: "Optus Sport" });
  });
});
