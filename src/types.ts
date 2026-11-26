export const API_VERSION = "1.0.0";
export const SERVICE_NAME = "PlayOn";

export type EventKind = "match" | "session" | "channel" | "show";
export type EventStatus = "live" | "upcoming" | "ended";
export type StreamProtocol = "hls" | "dash" | "direct";
export type PlayerHint = "hls.js" | "shaka" | "mpegts" | "native";
export type LogLevel = "silent" | "error" | "info";

export interface ProxyEnv {
  PROXY_ALLOWED_HOSTS?: string;
  PROXY_SIGNING_SECRET?: string;
  PROXY_SIG_TTL_SEC?: string;
  ALLOWED_ORIGINS?: string;
}

export interface WorkerEnv extends ProxyEnv {
  ENVIRONMENT?: string;
  LOG_LEVEL?: string;
}

export interface EventTeam {
  id: string;
  name: string;
  code: string;
  logo: string | null;
}

export interface EventCompetition {
  id: string;
  name: string;
  logo: string | null;
}

export interface EventDetails {
  format: string | null;
  session: string | null;
  matchNumber: string | null;
  stage: string | null;
  gender: "men" | "women" | null;
  ageGroup: string | null;
  squad: string | null;
}

export interface EventDebugInfo {
  canonicalKey: string;
  providerPointers: Record<string, string>;
  providerRawIds: Record<string, string[]>;
  mergeType: MergeResolutionType;
  mergeConfidence: number;
  mergeSignals: string[];
}

export interface EventSummary {
  id: string;
  kind: EventKind;
  status: EventStatus;
  sport: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  hot: boolean;
  competition: EventCompetition;
  teams: { home: EventTeam; away: EventTeam } | null;
  details: EventDetails | null;
  poster: string | null;
  banner: string | null;
  broadcasters: string[];
  languages: string[];
  providerCount: number;
  streamCount: number;
  maxQuality: string | null;
  hasDrmFree: boolean;
  hasWebPlayable: boolean;
  streamsUrl: string;
  debug?: EventDebugInfo;
}

export interface StreamDrm {
  scheme: "clearkey" | "widevine";
  keys?: Array<{ kid: string; key: string }>;
}

export interface StreamMirror {
  provider: string;
  url: string;
  protocol: StreamProtocol;
}

export interface StreamRendition {
  quality: string;
  width: number;
  height: number;
  bitrateBps: number;
  fps: number;
  codecs: string | null;
  url: string;
}

export interface PlayableStream {
  id: string;
  rank: number;
  score: number;
  broadcaster: string;
  broadcasterGroup: string;
  cameraAngle: string | null;
  protocol: StreamProtocol;
  quality: string;
  height: number | null;
  bitrateBps: number | null;
  codecs: string | null;
  language: string;
  languageName: string;
  url: string;
  directOriginUrl: string | null;
  proxyUrl: string;
  needsProxy: boolean;
  webPlayable: boolean;
  player: PlayerHint;
  headers: Record<string, string> | null;
  drm: StreamDrm | null;
  hlsVerified: boolean;
  renditions: StreamRendition[];
  providers: string[];
  mirrors: StreamMirror[];
}

export interface StreamExclusion {
  reason: "DONATION_SPAM" | "MISSING_URL" | "INVALID_SCHEME" | "NON_MEDIA_URL";
  provider: string;
  details: string;
}

export interface StreamAuditSummary {
  totalRaw: number;
  validCount: number;
  excludedCount: number;
  exclusions: StreamExclusion[];
}

export interface StreamProviderBreakdown {
  provider: string;
  name: string;
  rawIdsQueried: number;
  rawStreamsReturned: number;
  status: "ok" | "empty" | "failed";
  latencyMs: number;
}

export interface StreamDebugInfo {
  providers: StreamProviderBreakdown[];
  audit: StreamAuditSummary;
}

export interface StreamsPayload {
  eventId: string;
  total: number;
  recommendedId: string | null;
  filters: {
    languages: string[];
    qualities: string[];
    protocols: StreamProtocol[];
    broadcasters: string[];
  };
  streams: PlayableStream[];
  debug?: StreamDebugInfo;
}

export interface EventDetailPayload extends EventSummary {
  streams?: PlayableStream[];
  streamMeta?: {
    total: number;
    recommendedId: string | null;
    languages: string[];
    qualities: string[];
    debug?: StreamDebugInfo;
  };
}

export interface SportFacetItem {
  id: string;
  label: string;
  live: number;
  upcoming: number;
  ended: number;
  total: number;
}

export interface CompetitionFacetItem {
  id: string;
  name: string;
  sport: string;
  logo: string | null;
  live: number;
  upcoming: number;
  total: number;
}

export interface TeamFacetItem {
  id: string;
  name: string;
  code: string;
  sport: string;
  logo: string | null;
  live: number;
  upcoming: number;
  total: number;
}

export interface BroadcasterFacetItem {
  id: string;
  name: string;
  group: string;
  live: number;
  upcoming: number;
  total: number;
  sports: string[];
}

export interface FacetsPayload {
  counts: {
    live: number;
    upcoming: number;
    ended: number;
    active: number;
  };
  sports: SportFacetItem[];
  competitions: CompetitionFacetItem[];
  teams: TeamFacetItem[];
  broadcasters: BroadcasterFacetItem[];
}

export interface EventsQuery {
  status?: EventStatus | "active" | "all";
  sport?: string;
  competition?: string;
  team?: string;
  broadcaster?: string;
  language?: string;
  kind?: EventKind;
  provider?: string;
  minProviders?: number;
  hot?: boolean;
  date?: string;
  from?: string;
  to?: string;
  window?: "live" | "2h" | "today" | "tomorrow" | "24h" | "7d";
  q?: string;
  sort?: "smart" | "time_asc" | "time_desc" | "popularity" | "title";
  limit?: number;
  offset?: number;
  page?: number;
  includeDebug?: boolean;
}

export interface StreamQuery {
  language?: string;
  quality?: string;
  protocol?: StreamProtocol;
  provider?: string;
  broadcaster?: string;
  drmFree?: boolean;
  webPlayable?: boolean;
  inspect?: boolean;
  includeDebug?: boolean;
}

export interface CollectionMeta {
  total: number;
  returned: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  counts: { live: number; upcoming: number; ended: number };
  stale: boolean;
  generatedAt: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
}

export interface UpstreamFormatItem {
  title?: string;
  logo?: string | null;
  webLink?: string | null;
}

export interface UpstreamEventInfo {
  eventId?: number | string;
  teamA?: string;
  teamB?: string;
  teamAFlag?: string | null;
  teamBFlag?: string | null;
  eventCat?: string | null;
  eventName?: string | null;
  eventType?: string | null;
  eventLogo?: string | null;
  eventBanner?: string | null;
  isHot?: string | number | boolean | null;
  isPinned?: number | boolean | null;
  isLive?: boolean | number | string | null;
  isEnded?: boolean | number | string | null;
  startTime?: string | number | null;
  endTime?: string | number | null;
}

export interface UpstreamMeta {
  id: string;
  type?: string;
  name?: string;
  poster?: string;
  background?: string;
}

export interface UpstreamStream {
  url?: string;
  externalUrl?: string;
  name?: string;
  title?: string;
  clearkey?: string;
  behaviorHints?: {
    notWebReady?: boolean;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

export interface CncDecodedPayload {
  provider?: string;
  data?: {
    eventId?: number | string;
    channelId?: number | string;
    title?: string;
    poster?: string;
    cat?: string;
    category?: string;
    formats?: Array<UpstreamFormatItem | string>;
    eventInfo?: UpstreamEventInfo;
  };
}

export interface CatalogExclusion {
  reason: "NON_OBJECT" | "MISSING_ID" | "INVALID_ARRAY";
  provider: string;
  details: string;
}

export type MergeResolutionType =
  | "exact_key"
  | "nodate_attach"
  | "cross_format"
  | "near_time"
  | "participant_surname"
  | "club_fuzzy"
  | "cross_sport_rescue";

export interface MergeDecisionRecord {
  eventId: string;
  canonicalKey: string;
  title: string;
  sport: string;
  mergeType: MergeResolutionType;
  confidence: number;
  providers: string[];
  rawItemCount: number;
  reversedHomeAway: boolean;
  signals: string[];
}

export interface PreventedMergeRecord {
  keyA: string;
  keyB: string;
  pair: string;
  reason:
    | "CONFLICTING_MATCH_NUMBER"
    | "CONFLICTING_FORMAT"
    | "CONFLICTING_SESSION"
    | "CONFLICTING_STAGE"
    | "CONFLICTING_AGE_GROUP"
    | "CONFLICTING_GENDER"
    | "CONFLICTING_SQUAD"
    | "CONFLICTING_KIND"
    | "EXCEEDED_TIME_WINDOW"
    | "INCOMPATIBLE_SPORT"
    | "CONFLICTING_PARTICIPANT_INITIAL";
  details: string;
}

export interface ProviderExtractionAccounting {
  provider: string;
  name: string;
  rawPayloadCount: number;
  validItemsCount: number;
  excludedItemsCount: number;
  mappedCount: number;
  unmappedIds: string[];
  exclusions: CatalogExclusion[];
}

export interface ReconciliationSummary {
  status: "verified_zero_loss" | "degraded_partial_loss";
  providersQueried: number;
  healthyProviders: number;
  rawPayloadItems: number;
  validItemsExtracted: number;
  excludedInvalidItems: number;
  unifiedEvents: number;
  activeEvents: number;
  endedEvents: number;
  multiProviderEvents: number;
  deduplicatedMerged: number;
  reconciledCrossFormat: number;
  reconciledNearTime: number;
  reconciledNoDate: number;
  reconciledParticipantSurname: number;
  reconciledClubFuzzy: number;
  reversedHomeAwayResolved: number;
  preventedFalseMerges: number;
  unmappedRawItemsCount: number;
  averageConfidence: number;
}

export interface FullReconciliationReport {
  generatedAt: string;
  summary: ReconciliationSummary;
  providerAccounting: ProviderExtractionAccounting[];
  mergeDecisions: MergeDecisionRecord[];
  preventedMerges: PreventedMergeRecord[];
}
