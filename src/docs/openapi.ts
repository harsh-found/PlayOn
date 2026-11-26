import { buildEdgeHeaders, computeWeakEtag, matchesIfNoneMatch, type CorsPolicy } from "../edge/cache";
import { API_VERSION, SERVICE_NAME } from "../types";

export const API_ROUTE_PATHS = [
  "/",
  "/api/facets",
  "/api/events",
  "/api/events/{id}",
  "/api/stream/{id}",
  "/api/proxy",
  "/api/health",
  "/api/metrics",
  "/api/openapi.json",
] as const;

let cachedSpecObject: Record<string, unknown> | null = null;
let cachedSpecBytes: Uint8Array | null = null;
let cachedSpecEtag: string | null = null;

const pList = (spec: string) =>
  spec.split(";").map((r) => {
    const [name, loc, t, desc, req] = r.split("|");
    return { name, in: loc === "p" ? "path" : "query", required: req === "1", description: desc, schema: { type: t === "i" ? "integer" : t === "b" ? "boolean" : "string" } };
  });

const STREAM_Q = "language|q|s|ISO 639-2;quality|q|s|Quality tier;protocol|q|s|hls|dash|direct;provider|q|s|Provider key;broadcaster|q|s|Broadcaster;drmFree|q|b|DRM-free only;webPlayable|q|b|Browser-playable;inspect|q|b|HLS probe;dashToHls|q|b|Opt-in unencrypted DASH to HLS proxyUrl (default false);include|q|s|debug";

export function buildOpenApiSpec(): Record<string, unknown> {
  if (cachedSpecObject) return cachedSpecObject;
  const tMap: Record<string, unknown> = { s: { type: "string" }, i: { type: "integer" }, b: { type: "boolean" }, n: { type: ["string", "null"] }, a: { type: "array", items: { type: "string" } }, o: { type: "object" } };
  const jR = (description: string, ref?: string) => ({ description, content: { "application/json": { schema: ref ? { $ref: `#/components/schemas/${ref}` } : { type: "object" } } } });
  const PROB = { description: "RFC 9457 Problem Details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } } };
  const R304 = { description: "Not Modified" };
  const paths: Record<string, unknown> = {};
  for (const [path, operationId, summary, r200, codes, params] of [
    ["/", "getManifest", "Service manifest", jR("Manifest", "ResourceManifest"), "304,405"],
    ["/api/facets", "getFacets", "Discovery facets", jR("Facets", "ResourceFacets"), "304,400,405,503", "sport|q|s|Sport;status|q|s|Status;q|q|s|Search"],
    ["/api/events", "listEvents", "Unified events", jR("Events", "CollectionEvents"), "304,400,405,503", "status|q|s|Status;sport|q|s|Sport;competition|q|s|Competition;team|q|s|Team;broadcaster|q|s|Broadcaster;language|q|s|Language;kind|q|s|Kind;provider|q|s|Provider;minProviders|q|i|Min providers;hot|q|b|Hot;date|q|s|YYYY-MM-DD;from|q|s|ISO start;to|q|s|ISO end;window|q|s|Window;q|q|s|Search;sort|q|s|Sort;limit|q|i|1-100;offset|q|i|Offset;page|q|i|Page;include|q|s|debug"],
    ["/api/events/{id}", "getEventDetail", "Event detail", jR("Event detail", "ResourceEventDetail"), "304,400,404,405,503", `id|p|s|Event ID|1;streams|q|b|Include streams;${STREAM_Q}`],
    ["/api/stream/{id}", "getEventStreams", "Dedicated fast stream lookup", jR("Streams", "ResourceStreams"), "304,400,404,405,503", `id|p|s|Event ID|1;${STREAM_Q}`],
    ["/api/proxy", "proxyStream", "Hardened media proxy", { description: "Media/M3U8" }, "206,400,403,405,413,422,502,503,504", "url|q|s|Public URL|1;referer|q|s|Referer;origin|q|s|Origin;ua|q|s|User-Agent;rewrite|q|b|Rewrite M3U8;hls|q|b|Opt-in unencrypted DASH to HLS (default false);rep|q|s|DASH representation ID;exp|q|i|HMAC expiry epoch seconds;sig|q|s|HMAC-SHA256 signature"],
    ["/api/health", "getHealth", "PoP health", jR("Healthy"), "405,503h"],
    ["/api/metrics", "getMetrics", "Telemetry & reconciliation", jR("Metrics"), "405", "detail|q|s|full"],
    ["/api/openapi.json", "getOpenApiSpec", "OpenAPI 3.1.0 schema", jR("OpenAPI JSON"), "304,405"],
  ] as ReadonlyArray<readonly [string, string, string, unknown, string, string?]>) {
    const responses: Record<string, unknown> = { "200": r200 };
    for (const c of codes ? codes.split(",") : []) {
      responses[c === "503h" ? "503" : c] = c === "304" ? R304 : c === "206" ? { description: "Partial" } : c === "503h" ? jR("Degraded") : PROB;
    }
    paths[path] = { get: { operationId, summary, ...(params ? { parameters: pList(params) } : {}), responses } };
  }
  const schemas: Record<string, unknown> = {};
  for (const [name, req, spec] of [
    ["ProblemDetails", "type,title,status,code,detail,instance", "type:s,title:s,status:i,code:s,detail:s,instance:s"],
    ["EventSummary", "id,kind,status,sport,title,competition,streamsUrl", "id:s,kind:s,status:s,sport:s,title:s,startAt:n,endAt:n,hot:b,providerCount:i,streamCount:i,maxQuality:n,hasDrmFree:b,hasWebPlayable:b,broadcasters:a,languages:a,streamsUrl:s"],
    ["PlayableStream", "id,rank,score,broadcaster,protocol,url,proxyUrl,needsProxy", "id:s,rank:i,score:i,broadcaster:s,protocol:s,quality:s,language:s,cameraAngle:n,codecs:n,url:s,proxyUrl:s,needsProxy:b,webPlayable:b"],
    ["ResourceManifest", "data,meta", "data:o,meta:o"],
    ["CollectionEvents", "data,meta", "data:[$EventSummary,meta:o"],
    ["ResourceEventDetail", "data,meta", "data:$EventSummary,meta:o"],
    ["ResourceStreams", "data,meta", "data:o,meta:o"],
    ["ResourceFacets", "data,meta", "data:o,meta:o"],
  ] as const) {
    const properties: Record<string, unknown> = {};
    for (const f of spec.split(",")) {
      const [k = "", t = "s"] = f.split(":");
      properties[k] = t[0] === "$" ? { $ref: `#/components/schemas/${t.slice(1)}` } : t.startsWith("[$") ? { type: "array", items: { $ref: `#/components/schemas/${t.slice(2)}` } } : tMap[t] ?? tMap.s;
    }
    schemas[name] = { type: "object", required: req.split(","), properties };
  }
  return (cachedSpecObject = {
    openapi: "3.1.0",
    info: { title: `${SERVICE_NAME} Edge API`, version: API_VERSION, description: "Edge live-sports aggregator, reconciliation engine, and stream router." },
    servers: [{ url: "/" }], paths, components: { schemas },
  });
}

export const isOpenApiMaterialized = (): boolean => cachedSpecObject !== null;
export const resetOpenApiCache = (): void => { cachedSpecObject = null; cachedSpecBytes = null; cachedSpecEtag = null; };

export function createOpenApiResponse(request: Request, cors?: CorsPolicy): Response {
  if (!cachedSpecBytes || !cachedSpecEtag) {
    cachedSpecBytes = new TextEncoder().encode(JSON.stringify(buildOpenApiSpec()));
    cachedSpecEtag = computeWeakEtag(cachedSpecBytes);
  }
  const notModified = matchesIfNoneMatch(request.headers.get("If-None-Match"), cachedSpecEtag);
  const headers = cors
    ? buildEdgeHeaders(cors, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=3600", ETag: cachedSpecEtag })
    : { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=3600", ETag: cachedSpecEtag, Vary: "Accept-Encoding" };
  return new Response(notModified || request.method === "HEAD" ? null : cachedSpecBytes, {
    status: notModified ? 304 : 200,
    headers,
  });
}
