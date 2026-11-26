import type { LogLevel } from "../types";

const RING_SIZE = 256;
const STATIC_ROUTES = new Set("/,/api/facets,/api/events,/api/proxy,/api/health,/api/metrics,/api/openapi.json".split(","));

class LatencyRing {
  private readonly samples = new Float64Array(RING_SIZE);
  private index = 0;
  private count = 0;
  push(ms: number): void { this.samples[this.index] = ms; this.index = (this.index + 1) & 255; if (this.count < RING_SIZE) this.count++; }
  percentiles(): { p50: number; p95: number; p99: number } {
    if (!this.count) return { p50: 0, p95: 0, p99: 0 };
    const s = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const p = (q: number) => Math.round((s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] ?? 0) * 100) / 100;
    return { p50: p(0.5), p95: p(0.95), p99: p(0.99) };
  }
}

export interface RequestLogRecord {
  requestId: string;
  cfRay: string | null;
  colo: string;
  method: string;
  route: string;
  status: number;
  durMs: number;
  cache: string;
  subrequests: number;
  degraded: boolean;
}

export function resolveLogLevel(raw?: string): LogLevel {
  const v = raw?.trim().toLowerCase();
  if (v === "info" || v === "error" || v === "silent") return v;
  return "silent";
}

export function emitRequestLog(level: LogLevel, entry: RequestLogRecord): void {
  if (level === "silent") return;
  if (level === "error" && entry.status < 500) return;
  const line = JSON.stringify({ level: entry.status >= 500 ? "error" : "info", ...entry });
  if (entry.status >= 500) console.error(line);
  else console.info(line);
}

export class EdgeTelemetry {
  private startedAt: number | null = null;
  private totalRequests = 0;
  private totalErrors = 0;
  private readonly globalLatency = new LatencyRing();
  private readonly routes = new Map<string, { requests: number; errors: number; latency: LatencyRing }>();

  static normalizePath(pathname: string, status: number): string {
    if (status === 404) return "/* (unmatched)";
    if (STATIC_ROUTES.has(pathname)) return pathname;
    if (/^\/api\/events\/[^/]+$/.test(pathname)) return "/api/events/:id";
    if (/^\/api\/stream\/[^/]+$/.test(pathname)) return "/api/stream/:id";
    return "/* (unmatched)";
  }

  record(pathname: string, status: number, durationMs: number): void {
    if (this.startedAt === null) this.startedAt = Date.now();
    const bucket = EdgeTelemetry.normalizePath(pathname, status), isErr = status >= 500;
    this.totalRequests++; if (isErr) this.totalErrors++; this.globalLatency.push(durationMs);
    let stat = this.routes.get(bucket);
    if (!stat) { stat = { requests: 0, errors: 0, latency: new LatencyRing() }; this.routes.set(bucket, stat); }
    stat.requests++; if (isErr) stat.errors++; stat.latency.push(durationMs);
  }

  snapshot() {
    const now = Date.now();
    if (this.startedAt === null) this.startedAt = now;
    const routes: Record<string, { requests: number; errors: number; p50Ms: number; p95Ms: number; p99Ms: number }> = {};
    for (const [r, st] of [...this.routes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const p = st.latency.percentiles();
      routes[r] = { requests: st.requests, errors: st.errors, p50Ms: p.p50, p95Ms: p.p95, p99Ms: p.p99 };
    }
    return {
      uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      latencyMs: this.globalLatency.percentiles(),
      routes,
    };
  }
}
