import type { UpstreamMeta, UpstreamStream } from "../src/types";

const PROVIDERS = [
  { key: "sportzx", id: "cnc_SportzXLiveEvents_tv" },
  { key: "playztv", id: "cnc_PlayZTVLiveEvents_tv" },
  { key: "livxow", id: "cnc_LivXowLiveEvents_tv" },
  { key: "sktech", id: "cnc_SKTechLiveEvents_tv" },
  { key: "playfy", id: "cnc_PlayFyLiveEvents_tv" },
  { key: "cricify", id: "cnc_CricifyLiveEvents_tv" },
] as const;

function encodeCncId(provider: string, data: object): string {
  const raw = `${provider}::${JSON.stringify(data)}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `cnc:${btoa(binary)}`;
}

interface MatchTemplate {
  sport: string;
  teamA: string;
  teamB: string;
  shortA: string;
  shortB: string;
  tournament: string;
  altTournament: string;
  offsetHours: number;
  durationHours: number;
  liveFlag: boolean;
  broadcasters: string[];
}

const MATCH_SEEDS: MatchTemplate[] = [
  { sport: "Cricket", teamA: "India", teamB: "Australia", shortA: "IND", shortB: "AUS", tournament: "ICC T20 World Cup", altTournament: "T20I Series", offsetHours: -1, durationHours: 4, liveFlag: true, broadcasters: ["Star Sports 1", "Star Sports 1 Hindi", "Willow Cricket HD", "Sky Sports Cricket"] },
  { sport: "Cricket", teamA: "Pakistan Women", teamB: "England Women", shortA: "PAK-W", shortB: "ENG-W", tournament: "Women's T20I Series", altTournament: "Cricket", offsetHours: -0.5, durationHours: 4, liveFlag: true, broadcasters: ["PTV Sports", "Sky Sports Cricket"] },
  { sport: "Cricket", teamA: "Afghanistan Under-19", teamB: "India Under-19", shortA: "AFG-U19", shortB: "IND-U19", tournament: "U19 Asia Cup | Final", altTournament: "Youth ODI", offsetHours: 2, durationHours: 8, liveFlag: false, broadcasters: ["Sony Sports Ten 1", "FanCode"] },
  { sport: "Cricket", teamA: "New Zealand", teamB: "Sri Lanka", shortA: "NZ", shortB: "SL", tournament: "ICC World Test Championship - 1st Test", altTournament: "Test Series", offsetHours: -2, durationHours: 8, liveFlag: true, broadcasters: ["Amazon Prime Video", "TNT Sports 1"] },
  { sport: "Cricket", teamA: "South Africa", teamB: "West Indies", shortA: "SA", shortB: "WI", tournament: "One Day International - 2nd ODI", altTournament: "ODI", offsetHours: 6, durationHours: 8.5, liveFlag: false, broadcasters: ["SuperSport Cricket", "ESPN+"] },
  { sport: "Football", teamA: "Manchester United", teamB: "Arsenal", shortA: "Man Utd", shortB: "Arsenal FC", tournament: "Premier League", altTournament: "EPL", offsetHours: -0.75, durationHours: 2.2, liveFlag: true, broadcasters: ["Sky Sports Main Event", "beIN Sports 1", "Optus Sport"] },
  { sport: "Football", teamA: "Fútbol Club Barcelona", teamB: "Real Madrid", shortA: "Barcelona", shortB: "Real Madrid CF", tournament: "La Liga", altTournament: "Copa del Rey 🇪🇸", offsetHours: 3, durationHours: 2.2, liveFlag: false, broadcasters: ["ESPN+", "DAZN 1 HD", "ViX Deportes"] },
  { sport: "Football", teamA: "Türkiye", teamB: "Côte d'Ivoire", shortA: "TÃ¼rkiye", shortB: "CÃ´te d'Ivoire", tournament: "International Friendly Games", altTournament: "FIFA Friendlies", offsetHours: -8, durationHours: 2, liveFlag: true, broadcasters: ["beIN Sports 2"] },
  { sport: "Football", teamA: "Bayern Munich", teamB: "Borussia Dortmund", shortA: "Bayern", shortB: "Dortmund", tournament: "Bundesliga", altTournament: "German Football", offsetHours: 5, durationHours: 2.2, liveFlag: false, broadcasters: ["Sky Sports Football", "Sport1 Germany"] },
  { sport: "Basketball", teamA: "Philadelphia 76ers", teamB: "Toronto Raptors", shortA: "76ers", shortB: "Raptors", tournament: "NBA", altTournament: "NBA Regular Season", offsetHours: -1.2, durationHours: 2.8, liveFlag: true, broadcasters: ["NBA League Pass", "ESPN HD", "TSN 1"] },
  { sport: "Basketball", teamA: "Sacramento Kings", teamB: "Los Angeles Lakers", shortA: "Kings", shortB: "Lakers", tournament: "NBA", altTournament: "Basketball", offsetHours: 4, durationHours: 2.8, liveFlag: false, broadcasters: ["NBA TV", "TNT Sports 2"] },
  { sport: "Ice Hockey", teamA: "Los Angeles Kings", teamB: "New York Rangers", shortA: "Kings", shortB: "Rangers", tournament: "NHL", altTournament: "Ice Hockey", offsetHours: -0.4, durationHours: 2.8, liveFlag: true, broadcasters: ["NHL Network", "Sportsnet HD"] },
  { sport: "American Football", teamA: "New York Giants", teamB: "Washington Commanders", shortA: "Giants", shortB: "Commanders", tournament: "NFL", altTournament: "American Football", offsetHours: 7, durationHours: 3.5, liveFlag: false, broadcasters: ["NFL Network", "Fox Sports HD"] },
  { sport: "Tennis", teamA: "Carlos Alcaraz", teamB: "Jannik Sinner", shortA: "Alcaraz", shortB: "Sinner", tournament: "ATP Indian Wells - Semi-Final", altTournament: "ATP", offsetHours: -1.5, durationHours: 3, liveFlag: true, broadcasters: ["Tennis Channel", "Sky Sports Tennis", "Eurosport 1"] },
  { sport: "Combat Sports", teamA: "Ciryl Gane", teamB: "Josh Hokit", shortA: "C. Gane", shortB: "J. Hokit", tournament: "UFC 334", altTournament: "Mixed Martial Arts", offsetHours: 8, durationHours: 4, liveFlag: false, broadcasters: ["ESPN+", "TNT Sports 1"] },
];

export function generateHeavyCatalogByProvider(
  baseNowMs = Date.now(),
  rounds = 10
): Map<string, UpstreamMeta[]> {
  const byCatalog = new Map<string, UpstreamMeta[]>();
  for (const p of PROVIDERS) {
    byCatalog.set(p.id, []);
  }

  // Generate 15 * rounds distinct match events across 6 providers (~77 items/round + 24 shows)
  for (let round = 0; round < rounds; round++) {
    for (let sIdx = 0; sIdx < MATCH_SEEDS.length; sIdx++) {
      const seed = MATCH_SEEDS[sIdx]!;
      const dayShiftHours = round * 24;
      const startMs = baseNowMs + (seed.offsetHours + dayShiftHours) * 3600_000;
      const endMs = startMs + seed.durationHours * 3600_000;
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      const matchTag = round > 0 ? ` Match ${round + 1}` : "";
      const isLiveNow = round === 0 && seed.liveFlag;

      // Each event appears on 4 to 6 providers with realistic provider-specific quirks
      for (let pIdx = 0; pIdx < PROVIDERS.length; pIdx++) {
        const p = PROVIDERS[pIdx]!;
        // Slight realistic variation: ~85% coverage per provider => ~765-900 items
        if ((round + sIdx + pIdx) % 7 === 0) continue;

        const reverseTeams = pIdx % 2 === 1;
        const useShort = pIdx === 0 || pIdx === 3;
        const tA = useShort ? seed.shortA : seed.teamA;
        const tB = useShort ? seed.shortB : seed.teamB;
        const teamA = reverseTeams ? tB : tA;
        const teamB = reverseTeams ? tA : tB;

        // Provider 4 (playfy) sometimes omits startTime to test nodate reconciliation
        const omitTime = pIdx === 4 && round < 2;
        // Provider 2 (livxow) sometimes shifts start time by +25 mins
        const providerStart =
          omitTime
            ? undefined
            : pIdx === 2
            ? new Date(startMs + 25 * 60_000).toISOString()
            : pIdx === 5
            ? startIso.replace("T", " ").replace(/\.\d+Z$/, " UTC")
            : startIso;

        const titlePrefix = isLiveNow ? "🔴 LIVE " : "";
        const displayName = `${titlePrefix}${teamA} vs ${teamB}${matchTag}`;
        const rawEventName =
          pIdx % 2 === 0
            ? `${seed.tournament}${matchTag}`
            : `${seed.altTournament}${matchTag}`;

        const rawId = encodeCncId(p.key, {
          eventId: `${p.key}_${round}_${sIdx}`,
          title: displayName,
          cat: seed.sport,
          formats: seed.broadcasters.slice(0, (pIdx % seed.broadcasters.length) + 1).map((b, bi) => ({
            title: `${b} - ${bi % 2 === 0 ? "FHD" : "HD"}`,
          })),
          eventInfo: {
            teamA,
            teamB,
            teamAFlag: `https://cdn.flags.example/${teamA.toLowerCase().replace(/[^a-z0-9]/g, "")}.png`,
            teamBFlag: `https://cdn.flags.example/${teamB.toLowerCase().replace(/[^a-z0-9]/g, "")}.png`,
            eventCat: pIdx === 3 ? "TV" : seed.sport,
            eventName: rawEventName,
            eventType: seed.tournament,
            eventLogo: `https://cdn.logos.example/${seed.sport.toLowerCase().replace(/\s+/g, "-")}.png`,
            isLive: isLiveNow,
            isHot: isLiveNow && sIdx < 4,
            startTime: providerStart,
            endTime: omitTime ? undefined : endIso,
          },
        });

        byCatalog.get(p.id)!.push({
          id: rawId,
          type: "tv",
          name: displayName,
          poster: `https://cards.example.com/gen?title=${encodeURIComponent(rawEventName)}&teamA=${encodeURIComponent(teamA)}&teamB=${encodeURIComponent(teamB)}${providerStart ? `&time=${encodeURIComponent(providerStart)}` : ""}&isLive=${isLiveNow}`,
        });
      }
    }
  }

  // Add motorsport & show channels so non-match flows are also benchmarked
  for (let pIdx = 0; pIdx < PROVIDERS.length; pIdx++) {
    const p = PROVIDERS[pIdx]!;
    for (const show of [
      { name: "Formula 1 - Las Vegas Grand Prix Qualifying", sport: "Motorsport" },
      { name: "Formula 1 - Las Vegas Grand Prix Race", sport: "Motorsport" },
      { name: "NFL RedZone", sport: "American Football" },
      { name: "WWE Monday Night Raw", sport: "Combat Sports" },
    ]) {
      const startIso = new Date(baseNowMs + 3600_000).toISOString();
      const rawId = encodeCncId(p.key, {
        eventId: `${p.key}_show_${show.name.slice(0, 8)}`,
        title: show.name,
        cat: show.sport,
        formats: [{ title: "Sky Sports F1 HD" }, { title: "ESPN+ FHD" }],
        eventInfo: {
          eventName: show.name,
          eventCat: show.sport,
          isLive: show.name.includes("Race"),
          startTime: startIso,
        },
      });
      byCatalog.get(p.id)!.push({ id: rawId, type: "tv", name: show.name });
    }
  }

  return byCatalog;
}

export function generateHeavyRawStreams(): Array<UpstreamStream & { providerKey: string }> {
  const providers = ["sportzx", "playztv", "livxow", "sktech", "playfy", "cricify"];
  const channels = [
    { name: "Star Sports 1 FHD", lang: "English", cdn: "https://akamaized.net/live/ss1" },
    { name: "Star Sports 1 Hindi HD", lang: "Hindi", cdn: "https://slivcdn.com/live/ss1-hin" },
    { name: "Sky Sports Cricket 1080p", lang: "English", cdn: "https://pv-cdn.net/live/sky-cric" },
    { name: "Willow Cricket HD", lang: "English", cdn: "https://msnetworks.net/willow" },
    { name: "Sony Sports Ten 1 [TAM]", lang: "Tamil", cdn: "https://slivcdn.com/live/ten1/TAM" },
    { name: "Tapmad Live 1080p", lang: "Urdu", cdn: "https://tapmad.com/live/feed1" },
    { name: "Amazon Prime Video 4K", lang: "English", cdn: "https://otte.cache.aiv-cdn.net/live/prime" },
    { name: "ESPN+ FHD", lang: "Spanish", cdn: "https://espn-cdn.example.net/live/deportes" },
  ];

  const out: Array<UpstreamStream & { providerKey: string }> = [];
  for (let i = 0; i < 120; i++) {
    const providerKey = providers[i % providers.length]!;
    if (i % 15 === 0) {
      out.push({
        providerKey,
        name: "DONATE GOAL: $500",
        title: "Support the project via Telegram t.me/spam",
        url: "https://t.me/spam_channel",
      });
      continue;
    }
    const ch = channels[i % channels.length]!;
    const variant = i % 3 === 0 ? "1080" : i % 3 === 1 ? "720" : "396";
    const isBridged = i % 4 === 0;
    const token = `exp=${1700000000 + i}~hmac=deadbeef${i}`;
    const ck =
      i % 5 === 0
        ? "0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210"
        : undefined;

    const url = isBridged
      ? `http://129.225.106.195/d/master.m3u8?d=${encodeURIComponent(`${ch.cdn}/manifest.mpd?hdnea=${token}`)}&maxh=${variant}${ck ? `&clearkey=${ck}` : ""}`
      : `${ch.cdn}/master_${variant}.m3u8?hdnea=${token}&t=${i}`;

    out.push({
      providerKey,
      name: `${ch.name} (${providerKey})`,
      title: `🏷️ ${ch.name} ${variant}p ~${variant === "1080" ? "6.2" : variant === "720" ? "3.5" : "0.8"} Mbps\n🛰️ ${providerKey}`,
      url,
      clearkey: ck,
      behaviorHints:
        i % 2 === 0
          ? {
              proxyHeaders: {
                request: {
                  Referer: "https://player.example.com/",
                  "User-Agent": "PlayOnPlayer/1.0",
                },
              },
            }
          : undefined,
    });
  }
  return out;
}

export function generateLargeM3u8Playlist(segments = 450): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/eng.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080,FRAME-RATE=50',
    "variants/1080p/index.m3u8",
  ];
  for (let i = 0; i < segments; i++) {
    lines.push("#EXTINF:6.000,");
    lines.push(`segments/seg_${i}.ts`);
  }
  return lines.join("\n");
}
