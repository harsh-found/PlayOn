# PlayOn

[![Version](https://img.shields.io/badge/version-1.0.1-111827?style=flat-square)](./CHANGELOG.md)
[![Runtime](https://img.shields.io/badge/Cloudflare%20Workers-workerd-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white)](./wrangler.toml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6%20strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.json)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-16A34A?style=flat-square)](./package.json)
[![Tests](https://img.shields.io/badge/tests-141%20passing-16A34A?style=flat-square)](./test)
[![Bundle](https://img.shields.io/badge/worker%20upload-75%20KiB%20gzip-0EA5E9?style=flat-square)](./package.json)
[![License](https://img.shields.io/badge/license-ISC-64748B?style=flat-square)](./package.json)

**PlayOn** is a zero-dependency Cloudflare Workers edge API that aggregates live sports catalogs across 6 upstream providers, reconciles duplicate fixtures into stable event IDs in `O(N)` time, deduplicates and ranks multi-CDN streams, and proxies HLS/DASH media with SSRF and HMAC-SHA256 protections.

Built to stay comfortably inside Cloudflare Workers Free-tier limits (`<= 10 ms` CPU per live catalog build, `<= 42` subrequests per request, `0` runtime npm dependencies).

---

## Performance & Footprint

Measured with `npm run bench` (deterministic 796-item and 2,493-item messy 6-provider fixtures, 120 raw streams, 450-segment HLS playlist) and `npx wrangler deploy --dry-run`:

| Metric | Measured Result | Notes |
| :--- | ---: | :--- |
| **300 live items catalog build (est. CPU)** | **`4.31 ms`** | Safe under Workers Free-tier `10 ms` CPU limit |
| **796-item 6-provider reconcile (steady median)** | **`11.45 ms`** | Decode `2.26 ms` · Normalize `4.33 ms` · Reconcile/Index `4.86 ms` |
| **2,493-item stress reconcile (steady median)** | **`29.38 ms`** | Proven linear `O(N)` (`2.57x` time for `3.13x` items, `11.78 ms / 1k`) |
| **20 filtered + search queries (warm, L1 miss)** | **`3.39 ms`** | `0.17 ms / req` via pre-indexed facet maps & cached JSON fragments |
| **20 cached HTTP responses (L1 hit)** | **`2.66 ms`** | `0.13 ms / req` pre-serialized fast path |
| **20 conditional `304 Not Modified` responses** | **`0.56 ms`** | `0.028 ms / req` weak `ETag` short-circuit |
| **Stream dedup + scoring + ranking (120 -> 40)** | **`0.77 ms`** | Includes spam filtering, bridge unwrapping & mirror folding |
| **HLS M3U8 rewrite (450 segments + tags)** | **`0.31 ms`** | Rewrites relative URIs, `EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-MEDIA` |
| **Unmapped raw catalog items** | **`0`** | Verified zero-loss accounting (`unmappedRawItemsCount === 0`) |
| **Bundle size (`dist/index.js` unminified)** | **`235.2 KB`** | `4,885 LOC` across `22` files in `src/` |
| **Cloudflare Worker upload (`--dry-run`)** | **`75.0 KiB gzip`** | `249.5 KiB` uncompressed (`0` runtime deps) |
| **Paginated `/api/events?limit=20` payload** | **`21.7 KB`** | Lean UI fields by default; debug metadata opt-in via `?include=debug` |

---

## Core Capabilities

- **6-Provider `O(N)` Match Reconciliation & Rotating CNCVerse Profiles:** Normalizes and merges strictly the 6 live-sports providers (`sportzx`, `playztv`, `livxow`, `sktech`, `playfy`, `cricify`) — auto-provisioning and rotating anonymous 6-provider CNCVerse profiles (L1 + L2 persisted, TTL-rotated, reactive `403`/`429` rotation, or optional `CNC_PROFILES` pool) so `CricifyLiveEvents` is always active alongside the other 5 feeds with zero non-sports overhead.
- **Stable `evt_*` Event IDs:** Anchored to a `04:00 UTC` sports-day rollover and non-volatile discriminators so IDs stay stable across provider churn, midnight kickoffs, and conflicting format tags.
- **Multi-CDN Stream Deduplication & Ranking:** Unwraps bridged player URLs, strips donation/non-media junk, detects ClearKey/Widevine/FairPlay DRM, folds identical CDN mirrors across providers while preserving distinct resolution (`maxh`), language, and broadcaster feeds, and ranks streams by protocol, resolution, verification, and reliability.
- **Hardened Streaming Media Proxy (`/api/proxy`):** Zero-copy passthrough with HTTP `Range` (`206 Partial Content`), streaming HLS M3U8 rewriting, opt-in lightweight unencrypted MPEG-DASH (`.mpd`) -> HLS v7 fMP4 (`.m3u8`) conversion (`?hls=1` / `?dashToHls=true`, **off by default**, rejects DRM with `422`), SSRF CIDR blocking, header sanitization, upstream CORS isolation, and optional Web Crypto HMAC-SHA256 signed URLs.
- **Two-Tier Edge Cache & Token Safety:** Memory-bounded L1 isolate LRU (`16 MiB`) backed by Cloudflare Cache API L2, canonicalized query keys (defeats cache-busting DoS), origin/signing key isolation, and dynamic TTL capping against upstream stream token expiry.
- **Runtime Resilience:** Per-request subrequest budget (`<= 42`), soft-quorum catalog refresh that never overwrites a healthier warm snapshot with a degraded partial refresh, per-host circuit breaker, and lazy-clock `workerd`-safe telemetry.

---

## API Surface

All JSON routes return `{ data, meta }` on success and RFC 9457 `application/problem+json` on errors. Every route supports `GET`, `HEAD`, `OPTIONS` CORS preflight, and returns `405 Method Not Allowed` with `Allow: GET, HEAD, OPTIONS` for unsupported methods.

| Method | Endpoint | Caching | Description |
| :--- | :--- | :--- | :--- |
| `GET` `HEAD` | `/` | `300s` + `ETag` | Service manifest, version (`1.0.1`), provider list, and `/api/*` link templates |
| `GET` `HEAD` | `/api/facets` | `30s` + `ETag` | Counts (`live`, `upcoming`, `ended`, `active`) and facets (`sports`, `competitions`, `teams`, `broadcasters`) |
| `GET` `HEAD` | `/api/events` | `15s`–`60s` + `ETag` | Unified schedule with multi-facet filters, search, sorting, pagination, and optional `?include=debug` |
| `GET` `HEAD` | `/api/events/:id` | `<= 20s` (token-capped) | Event detail plus embedded ranked streams (`?streams=false` for metadata only) |
| `GET` `HEAD` | `/api/stream/:id` | `<= 20s` (token-capped) | Dedicated stream lookup/refresh with language, quality, broadcaster, protocol, and DRM filters |
| `GET` `HEAD` `OPTIONS` | `/api/proxy` | Passthrough / `2s`–`30s` | Zero-copy Range/DASH/HLS proxy, M3U8 rewriter, and opt-in `?hls=1` unencrypted DASH->HLS converter (off by default) |
| `GET` `HEAD` | `/api/health` | `no-store` | PoP metadata, provider availability (`6/6`), CNCVerse profile status, catalog freshness, and circuit-breaker states |
| `GET` `HEAD` | `/api/metrics` | `no-store` | Per-route `p50`/`p95`/`p99` latency, L1/L2 cache stats, dead-stream count, reconciliation audit |
| `GET` `HEAD` | `/api/openapi.json` | `3600s` + `ETag` | Lazy-generated OpenAPI 3.1.0 specification locked 1:1 to all 9 routes |

### Query Parameters

<details>
<summary><strong><code>GET /api/events</code> parameters</strong></summary>

| Param | Type / Values | Default | Notes |
| :--- | :--- | :--- | :--- |
| `status` | `active` \| `live` \| `upcoming` \| `ended` \| `all` | `active` | Invalid values return `400` |
| `sport` | string (e.g. `cricket`, `football`, `soccer`, `tennis`) | — | Supports common aliases (`soccer` -> `football`) |
| `competition` | slug or name (e.g. `premier-league`) | — | Pre-indexed lookup |
| `team` | slug or name (e.g. `india`, `arsenal`) | — | Matches either home or away side |
| `broadcaster` | slug or name (e.g. `sky-sports-cricket`) | — | Pre-indexed lookup |
| `language` | ISO 639-2 code (`eng`, `hin`, `spa`, ...) | — | Case-insensitive |
| `kind` | `match` \| `session` \| `channel` \| `show` | — | Filters event classification |
| `provider` | `sportzx` \| `playztv` \| `livxow` \| `sktech` \| `playfy` \| `cricify` | — | Filters events covered by provider |
| `minProviders` | integer `1..6` | — | Useful for high-confidence multi-source fixtures |
| `hot` | `true` \| `false` | — | Featured / marquee fixtures |
| `date` | `YYYY-MM-DD` | — | UTC day filter |
| `from` / `to` | ISO 8601 timestamp or epoch | — | Range filter on `startAt` |
| `window` | `live` \| `2h` \| `today` \| `tomorrow` \| `24h` \| `7d` | — | Relative time window |
| `q` | string (max `120` chars) | — | Case-insensitive multi-token search across title, teams, competition, broadcasters |
| `sort` | `smart` \| `time_asc` \| `time_desc` \| `popularity` \| `title` | `smart` | `smart`: live + hot + provider count -> start time |
| `limit` / `offset` / `page` | `1..100` / `0..10000` / `1..1000` | `25` / `0` | Standard pagination |
| `include` | `debug` | — | Appends canonical keys, merge signals, and raw provider pointers |

</details>

<details>
<summary><strong><code>GET /api/events/:id</code> &amp; <code>GET /api/stream/:id</code> parameters</strong></summary>

| Param | Type / Values | Default | Notes |
| :--- | :--- | :--- | :--- |
| `streams` | `true` \| `false` | `true` | `/api/events/:id` only; `false` skips upstream stream fanout |
| `language` | ISO 639-2 code (`eng`, `hin`, ...) | — | Filters returned stream list (event-level summary flags stay accurate) |
| `quality` | `4K`, `1080p`, `720p`, `540p`, `Auto`, ... | — | Case-insensitive |
| `protocol` | `hls` \| `dash` \| `direct` | — | Invalid values return `400` |
| `broadcaster` | slug or name | — | Matches broadcaster or broadcaster group |
| `provider` | provider key | — | Filters streams backed by provider |
| `drmFree` | `true` \| `false` | — | Excludes ClearKey/Widevine/FairPlay streams when `true` |
| `webPlayable` | `true` \| `false` | — | Filters browser-playable HLS/DASH/ClearKey feeds |
| `inspect` | `true` \| `false` | `true` | `false` skips live HLS master playlist probing for lowest latency |
| `dashToHls` | `true` \| `false` | `false` | Opt-in: appends `&hls=1` (and HMAC signature when signing is enabled) to `proxyUrl` for **unencrypted** DASH streams only |
| `include` | `debug` | — | Includes per-provider stream fetch timings and spam exclusion audit |

</details>

### Quick Examples

```bash
# Discover live sports and counts
curl -sS https://<worker-domain>/api/facets

# Query live & upcoming cricket matches
curl -sS "https://<worker-domain>/api/events?sport=cricket&status=active&limit=20"

# Fetch ranked, DRM-free HLS streams for a single event (skip live probe)
curl -sS "https://<worker-domain>/api/stream/evt_2abd9d9ce612?protocol=hls&drmFree=true&inspect=false"

# Health & zero-loss reconciliation telemetry
curl -sS https://<worker-domain>/api/health
curl -sS https://<worker-domain>/api/metrics
```

<details>
<summary><strong>Sample JSON envelopes (success &amp; RFC 9457 error)</strong></summary>

```json
{
  "data": {
    "service": "PlayOn",
    "version": "1.0.1",
    "status": "ok",
    "catalog": "warm",
    "edge": { "colo": "SIN", "country": "SG", "city": "Singapore" },
    "providers": { "total": 6, "healthy": 6 },
    "profile": { "mode": "auto", "active": true, "rotations": 0, "expiresAt": "2026-11-26T15:34:25.506Z" },
    "upstreamHosts": [
      { "host": "https://cncverse.dpdns.org", "state": "closed", "failures": 0 }
    ]
  },
  "meta": {
    "stale": false,
    "generatedAt": "2026-11-26T09:34:25.506Z"
  }
}
```

```json
{
  "type": "https://playon.dev/problems/invalid-query",
  "title": "Bad Request",
  "status": 400,
  "code": "INVALID_QUERY",
  "detail": "Invalid 'status'.",
  "instance": "/api/events"
}
```

</details>

---

## Architecture

PlayOn enforces a hard architectural boundary between **pure deterministic domain code** (`src/domain/*` — zero `fetch`, `caches`, timers, Web Crypto, or `Date.now()`) and **Cloudflare Workers edge I/O** (`src/edge/*`), verified on every check by `npm run lint`.

```text
Client Request
  │
  ▼
src/index.ts  (Router · Query Canonicalizer · Method/CORS/ETag Guards)
  ├──► L1 Isolate LRU (16 MiB) ──► HIT-L1 / 304 (< 0.15 ms)
  ├──► L2 Cloudflare Cache API ──► HIT-L2 / 304
  └──► MISS
        ├── Catalog routes (/api/facets, /api/events)
        │     └── src/edge/aggregator.ts (Soft Quorum + L2 Snapshot Hydration)
        │           ├── src/edge/upstream.ts (Circuit Breaker · Budget · cncverse.dpdns.org)
        │           └── src/domain/reconciliation.ts (3-Pass O(N) Merge · Zero-Loss Audit)
        │
        ├── Stream routes (/api/events/:id, /api/stream/:id)
        │     └── src/edge/aggregator.ts (Fanout · Bounded HLS Probe · HMAC Signing)
        │           └── src/domain/streams.ts (Dedup · Mirror Fold · Scoring · Token Expiry)
        │
        └── Media proxy (/api/proxy)
              └── src/edge/proxy.ts (SSRF Check · HMAC Verify · Range 206 · M3U8 Rewrite)
```

<details>
<summary><strong>Module layout (<code>src/</code>)</strong></summary>

```text
src/
├── index.ts                 # Zero-dependency Worker router, query validation & HTTP contracts
├── types.ts                 # Shared API, domain, stream, proxy, and WorkerEnv types
├── data/
│   └── taxonomy.ts          # Provider registry, sport taxonomy, team/club/broadcaster tables
├── docs/
│   └── openapi.ts           # Lazy OpenAPI 3.1.0 generator (zero cold-start parse cost)
├── domain/                  # Pure deterministic logic (statically checked: zero I/O or ambient clock)
│   ├── channel.ts           # Broadcaster normalization, language extraction & host/path inference
│   ├── cnc.ts               # Base64/UTF-8 rawId decoder & schema validator with exclusion audit
│   ├── dash.ts              # Pure unencrypted MPEG-DASH (.mpd) -> HLS v7 fMP4 (.m3u8) converter
│   ├── drm.ts               # ClearKey, Widevine & FairPlay detector
│   ├── identity.ts          # Format, session, stage, gender, age-group & conflict matrix
│   ├── m3u8.ts              # SSRF CIDR/host checks, HLS master parser & fast M3U8 rewriter
│   ├── normalizer.ts        # Canonical keys, 04:00 UTC sports-day bucketing & stable evt_* IDs
│   ├── reconciliation.ts    # Multi-pass O(N) reconciliation, pre-indexed queries & snapshot codec
│   └── streams.ts           # Bridge unwrapping, CDN dedup, mirror folding, scoring & expiry parser
└── edge/                    # Cloudflare Workers runtime I/O, caching & security
    ├── aggregator.ts        # Snapshot orchestration, degraded-overwrite guard & stream fanout
    ├── budget.ts            # Per-request subrequest cap (42 hard cap; sheds hedges/probes early)
    ├── cache.ts             # Byte-bounded L1 LRU + Cache API L2 + CORS/ETag/RFC 9457 helpers
    ├── dead-streams.ts      # Bounded failed-stream tracker (-35 score demotion + auto recovery)
    ├── hls.ts               # Budget-bounded HLS master playlist truth inspector
    ├── proxy.ts             # Hardened zero-copy media proxy with Range 206 & signed M3U8 rewrites
    ├── signing.ts           # Web Crypto HMAC-SHA256 URL signer & constant-time verifier
    ├── telemetry.ts         # Lazy-clock workerd-safe p50/p95/p99 collector & structured logger
    └── upstream.ts          # Single-flight upstream JSON client with circuit breaker & stream LRU
```

</details>

---

## Security & Edge Hardening

| Threat Vector | Defense Implemented | Config |
| :--- | :--- | :--- |
| **SSRF / Internal Network Probing** | Blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6, non-HTTP(S) schemes, URL credentials, and redirect hops into private IPs | Always on |
| **Open-Proxy Abuse** | Mandatory HMAC-SHA256 `sig` + `exp` verification on `/api/proxy` with automatic signature propagation into every rewritten M3U8 child playlist and media segment | `PROXY_SIGNING_SECRET` |
| **Arbitrary Egress Domains** | Optional wildcard host allowlist checked on initial request and every redirect hop | `PROXY_ALLOWED_HOSTS` |
| **CORS Spoofing / Header Injection** | Strips upstream `Access-Control-*` headers before applying PlayOn CORS policy; enforces RFC header-name validation and CRLF stripping | `ALLOWED_ORIGINS` |
| **Cache-Busting DoS** | Unknown query parameters (`utm_*`, random tokens) are discarded before cache-key synthesis; keys isolate request `origin` and signing mode | Always on |
| **Stale / Expired Stream Tokens** | Extracts upstream token `exp`/`expires`/`hdnea`/`hdnts` (including wrapped bridge targets) and caps response `Cache-Control` TTL (`no-store` when `< 10s` left) | Always on |
| **Workers Subrequest Exhaustion** | `RequestBudget` enforces a 42-subrequest ceiling and drops non-critical hedges/probes early before hitting Cloudflare's 50-subrequest error | Always on |

---

## Configuration

Copy `.dev.vars.example` to `.dev.vars` for local `wrangler dev`, or configure production secrets and `[vars]` in `wrangler.toml`:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PROXY_SIGNING_SECRET` | Secret | *(unset)* | 32-byte random hex key enabling mandatory HMAC-SHA256 signed URLs on `/api/proxy` (recommended in production) |
| `PROXY_SIG_TTL_SEC` | Var | `21600` | Signed proxy URL lifetime in seconds (clamped to `30..86400`) |
| `PROXY_ALLOWED_HOSTS` | Var | *(any public host)* | Comma-separated egress allowlist supporting leading wildcards (e.g. `*.akamaized.net,*.aiv-cdn.net`) |
| `ALLOWED_ORIGINS` | Var | `*` | Comma-separated CORS origin allowlist (reflects matched origin with `Vary: Origin, Accept-Encoding`) |
| `CNC_PROFILES` | Var | *(auto-provision)* | Optional comma-separated static CNCVerse profile ID pool (`p_...`); when unset, PlayOn auto-provisions & rotates anonymous 6-provider profiles |
| `CNC_PROFILE_TTL_SEC` | Var | `21600` | CNCVerse profile rotation TTL in seconds (clamped to `300..86400`; also rotates reactively on `403`/`429`) |
| `LOG_LEVEL` | Var | `silent` | Structured JSON request logging (`silent` \| `error` \| `info`) |

---

## Local Development & Verification

```bash
npm install

# Quality gates
npm run typecheck     # Strict tsc --noEmit (strict + noUncheckedIndexedAccess)
npm run lint          # Architecture boundary, workerd safety & hygiene check
npm test              # 141-test Vitest suite (unit, contract, chaos, fuzz, security)
npm run build         # Bundles dist/index.js (es2022 ESM, unminified)
npm run bench         # Deterministic CPU, latency, payload & footprint benchmark

# Run locally on Cloudflare workerd (http://127.0.0.1:3000)
npm run dev

# End-to-end live HTTP smoke verification (16 checks incl. 6/6 providers, Cricify, opt-in DASH->HLS)
npm run smoke -- http://127.0.0.1:3000
```

---

## Deploying to Cloudflare Workers

```bash
# 1. Authenticate (or provide CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in CI)
npx wrangler login

# 2. Set production proxy signing secret (recommended)
openssl rand -hex 32 | npx wrangler secret put PROXY_SIGNING_SECRET

# 3. Verify bundle & wrangler.toml with zero side effects
npm run typecheck && npm run lint && npm test && npm run build
npx wrangler deploy --dry-run

# 4. Deploy
npm run deploy

# 5. Verify live production worker
npm run smoke -- https://<your-worker-domain>
```

Rollback to the previous deployment at any time:

```bash
npx wrangler deployments list
npx wrangler rollback
```

---

## Release History

See [CHANGELOG.md](./CHANGELOG.md) for release notes and version history (`v1.0.1`).
