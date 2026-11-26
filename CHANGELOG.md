# Changelog

All notable changes to **PlayOn** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-11-26

### Added
- **CNCVerse 6-Provider Auto-Provisioning & Rotating Profile Manager (`src/edge/upstream.ts`):** Automatically provisions anonymous `p_<12>` profiles on `https://cncverse.dpdns.org` with strictly the 6 live-sports providers enabled (`CricifyLiveEvents` + 5 default live-sports providers; all 30 non-sports addons disabled). Persists active profiles across L1 + Cloudflare Cache API L2, rotates by `CNC_PROFILE_TTL_SEC` (default `21600s`, clamped `[300, 86400]`), rotates reactively on `403`/`429` with a transparent single retry, supports optional static `CNC_PROFILES` pools, falls back cleanly if profile setup is unreachable, and exposes non-sensitive profile status on `/api/health`.
- **Opt-In Unencrypted MPEG-DASH (`.mpd`) → HLS v7 fMP4 (`.m3u8`) Converter (`src/domain/dash.ts`, `src/edge/proxy.ts`):** Off by default (zero change to default `/api/proxy`, `/api/stream/:id`, or `/api/events/:id` responses). Opt-in via `?hls=1` on `/api/proxy` or `?dashToHls=true` on `/api/stream/:id` & `/api/events/:id` (applied strictly to unencrypted DASH streams). Supports `SegmentTemplate` + `SegmentTimeline` (including unbounded `r="-1"` repeats), fixed-duration live sliding windows, `SegmentList`, nested `<BaseURL>`, duplicate video/audio `Representation@id` disambiguation (preserving exact `$RepresentationID$` expansion), SSRF validation, and full Web Crypto HMAC-SHA256 signature propagation. Rejects DRM-protected MPDs cleanly with HTTP `422` (`DASH_DRM_UNSUPPORTED`).
- **Bounded Upstream Proxy Timeouts (`src/edge/proxy.ts`):** Added response-header `AbortController` timeouts (`10s` manifests/HEAD, `15s` media passthrough; cleared once headers arrive so active streaming bodies are never interrupted) returning RFC 9457 HTTP `504` (`UPSTREAM_TIMEOUT`) and feeding `DeadStreamTracker`.
- **Expanded Verification (`test/dash-and-profile.test.ts`, `scripts/smoke.ts`):** Added 13 unit/integration tests (141 total) and upgraded live smoke checks to verify `6/6` healthy providers, active CNCVerse profile, non-zero Cricify accounting with `0` unmapped items, and live opt-in `?hls=1` DASH-to-HLS conversion.

### Fixed
- **Cricify Catalog Returning 0 Items:** Routed both catalog (`/u/<pid>/catalog/tv/...`) and stream (`/u/<pid>/stream/tv/...`) requests through the active 6-provider CNCVerse profile so `cricify` returns live matches and streams alongside all other 5 providers.
- **Range Header Stripping on `?hls=1`:** Prevented client `Range` headers from being forwarded on upstream `.mpd` fetches during HLS conversion so manifests are never truncated by `206 Partial Content`.
- **Profile Rotation Accounting & Docs:** Eliminated reactive rotation double-counting and aligned `PROXY_SIG_TTL_SEC` documentation (`30..86400`) with runtime clamping.

## [1.0.0] - 2026-11-26

Initial public release of **PlayOn** — a zero-dependency Cloudflare Workers edge API for live-sports aggregation, deterministic cross-provider match reconciliation, multi-CDN stream deduplication, and hardened media proxying.

### Added

#### HTTP API (`/api/*`)
- `GET`/`HEAD /` — Service manifest, version (`1.0.0`), provider registry, and `/api/*` link templates with `ETag` / `304 Not Modified`.
- `GET`/`HEAD /api/facets` — Discovery taxonomy and live/upcoming/ended counts across sports, competitions, teams, and broadcasters.
- `GET`/`HEAD /api/events` — Unified live, upcoming, and ended schedule with multi-facet filtering (`sport`, `status`, `competition`, `team`, `broadcaster`, `language`, `kind`, `provider`, `minProviders`, `hot`, `date`, `from`, `to`, `window`, `q`), sorting, pagination, and optional `?include=debug`.
- `GET`/`HEAD /api/events/:id` — Event detail with embedded ranked streams (`?streams=false`, stream filters, `?inspect=false`, `?include=debug`).
- `GET`/`HEAD /api/stream/:id` — Fast stream lookup and refresh endpoint with language, quality, broadcaster, protocol, DRM-free, and web-playability filters.
- `GET`/`HEAD`/`OPTIONS /api/proxy` — Zero-copy edge media proxy supporting HTTP `Range` (`206 Partial Content`), streaming HLS M3U8 playlist rewriting, and `HEAD` body cancellation.
- `GET`/`HEAD /api/health` — PoP metadata, provider health, catalog freshness, and upstream circuit-breaker states (`Cache-Control: no-store`).
- `GET`/`HEAD /api/metrics` — Per-route `p50`/`p95`/`p99` latency percentiles, L1/L2 cache stats, demoted-stream count, and zero-loss reconciliation accounting (`Cache-Control: no-store`).
- `GET`/`HEAD /api/openapi.json` — Lazy-generated OpenAPI 3.1.0 specification locked 1:1 to all 9 routes.
- Uniform `{ data, meta }` JSON responses, RFC 9457 `application/problem+json` errors, strict `405 Method Not Allowed` with `Allow: GET, HEAD, OPTIONS`, `X-PlayOn-Version`, `Server-Timing`, and `X-Request-Id`.

#### Domain Engine (`src/domain/*`)
- Pure, deterministic domain layer (`cnc`, `normalizer`, `identity`, `channel`, `drm`, `streams`, `reconciliation`, `m3u8`) strictly decoupled from Workers I/O and ambient clocks.
- Multi-pass `O(N)` reconciliation across 6 live-sports providers (`sportzx`, `playztv`, `livxow`, `sktech`, `playfy`, `cricify`) with exact canonical keys, same-kickoff cricket format resolution, 4h near-time merging, individual-sport surname matching, club fuzzy/acronym matching, reversed home/away handling, and zero-loss item accounting (`unmappedRawItemsCount === 0`).
- Stable `evt_*` identifiers anchored to a `04:00 UTC` sports-day boundary and non-volatile discriminators so IDs survive provider churn and midnight kickoffs.
- Multi-CDN stream deduplication, ClearKey/Widevine/FairPlay DRM detection, bridged stream unwrapping, mirror folding, donation-spam/non-media exclusion, reliability scoring, and bounded HLS master playlist probing.

#### Edge Runtime, Security & Caching (`src/edge/*`)
- Auto-provisioning and rotating 6-provider CNCVerse profile manager (`UpstreamClient`): enables `CricifyLiveEvents` and disables non-sports defaults so strictly all 6 live-sports providers return live catalogs & streams; persists active profile in L1 + L2 Cache API, rotates on `CNC_PROFILE_TTL_SEC` (default 6h) and reactively on `403`/`429`, supports optional `CNC_PROFILES` static pool, and falls back gracefully if profile setup is unreachable.
- Opt-in lightweight unencrypted MPEG-DASH (`.mpd`) -> HLS v7 fMP4 (`.m3u8`) converter (`src/domain/dash.ts`): **off by default**; enabled via `?hls=1` on `/api/proxy` or `?dashToHls=true` on `/api/stream/:id` & `/api/events/:id` (unencrypted DASH only; rejects DRM manifests with HTTP `422 DASH_DRM_UNSUPPORTED`; fully HMAC-SHA256 signed when `PROXY_SIGNING_SECRET` is set).
- Two-tier caching: byte-budgeted L1 isolate LRU (`16 MiB` cap) + Cloudflare Cache API L2 with query canonicalization (cache-busting DoS defense), origin/signing key isolation, and dynamic TTL capping against upstream stream token expiry.
- Hardened `/api/proxy`: SSRF defense blocking private, loopback, link-local, CGNAT, and IPv6-mapped IP ranges; redirect-loop caps; optional `PROXY_ALLOWED_HOSTS` wildcard allowlist; optional Web Crypto HMAC-SHA256 URL signing (`PROXY_SIGNING_SECRET`) propagated to rewritten M3U8 and DASH->HLS segments; upstream CORS header stripping with `ALLOWED_ORIGINS` enforcement.
- Cloudflare Workers Free-tier survivability: per-request `RequestBudget` (`<= 42` subrequests hard cap), soft-quorum catalog refresh with degraded-overwrite protection, circuit-breakered upstream client targeting `https://cncverse.dpdns.org`, and lazy-clock `workerd`-safe telemetry.

#### Tooling & Quality Gates
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`), static architecture/hygiene linter (`npm run lint`), 139-test Vitest suite (`npm test`), deterministic CPU/payload/footprint benchmark (`npm run bench`), and live `workerd` HTTP smoke suite (`npm run smoke`).
- Ready-to-deploy `wrangler.toml` and `.dev.vars.example` (`~233 KB` unminified bundle / `~74 KiB` gzip upload).
