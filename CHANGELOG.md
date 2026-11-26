# Changelog

All notable changes to **PlayOn** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Two-tier caching: byte-budgeted L1 isolate LRU (`16 MiB` cap) + Cloudflare Cache API L2 with query canonicalization (cache-busting DoS defense), origin/signing key isolation, and dynamic TTL capping against upstream stream token expiry.
- Hardened `/api/proxy`: SSRF defense blocking private, loopback, link-local, CGNAT, and IPv6-mapped IP ranges; redirect-loop caps; optional `PROXY_ALLOWED_HOSTS` wildcard allowlist; optional Web Crypto HMAC-SHA256 URL signing (`PROXY_SIGNING_SECRET`) propagated to rewritten M3U8 segments; upstream CORS header stripping with `ALLOWED_ORIGINS` enforcement.
- Cloudflare Workers Free-tier survivability: per-request `RequestBudget` (`<= 42` subrequests hard cap), soft-quorum catalog refresh with degraded-overwrite protection, circuit-breakered upstream client targeting `https://cncverse.dpdns.org`, and lazy-clock `workerd`-safe telemetry.

#### Tooling & Quality Gates
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`), static architecture/hygiene linter (`npm run lint`), 128-test Vitest suite (`npm test`), deterministic CPU/payload/footprint benchmark (`npm run bench`), and live `workerd` HTTP smoke suite (`npm run smoke`).
- Ready-to-deploy `wrangler.toml` and `.dev.vars.example` (`~209 KB` unminified bundle / `~67 KiB` gzip upload).
