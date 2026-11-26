/**
 * PlayOn live HTTP smoke test against a running Cloudflare Worker / wrangler dev instance.
 * Usage: npm run smoke -- http://127.0.0.1:3000
 */

interface CheckResult {
  name: string;
  ok: boolean;
  status?: number;
  detail?: string;
}

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const results: CheckResult[] = [];

function assertCheck(name: string, ok: boolean, status?: number, detail?: string): void {
  results.push({ name, ok, status, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${status !== undefined ? ` (HTTP ${status})` : ""}${detail ? ` — ${detail}` : ""}`);
}

async function run(): Promise<void> {
  // 1. GET / manifest + ETag + 304
  const rootRes = await fetch(`${baseUrl}/`);
  const rootEtag = rootRes.headers.get("ETag") ?? "";
  const rootJson = (await rootRes.json()) as { data?: { service?: string; links?: Record<string, string> } };
  assertCheck(
    "GET / manifest",
    rootRes.status === 200 && rootJson.data?.service === "PlayOn" && Boolean(rootEtag),
    rootRes.status,
    `etag=${rootEtag}`
  );

  const root304 = await fetch(`${baseUrl}/`, { headers: { "If-None-Match": rootEtag } });
  assertCheck("GET / conditional 304", root304.status === 304, root304.status);

  // 2. HEAD /
  const headRoot = await fetch(`${baseUrl}/`, { method: "HEAD" });
  const headBody = await headRoot.text();
  assertCheck("HEAD / empty body", headRoot.status === 200 && headBody.length === 0, headRoot.status);

  // 3. OPTIONS /api/events CORS preflight
  const optRes = await fetch(`${baseUrl}/api/events`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  });
  assertCheck(
    "OPTIONS /api/events preflight",
    optRes.status === 204 && Boolean(optRes.headers.get("Access-Control-Allow-Methods")),
    optRes.status
  );

  // 4. POST /api/events -> 405 Method Not Allowed + Allow
  const postRes = await fetch(`${baseUrl}/api/events`, { method: "POST" });
  assertCheck(
    "POST /api/events -> 405",
    postRes.status === 405 && (postRes.headers.get("Allow") ?? "").includes("GET"),
    postRes.status,
    `Allow=${postRes.headers.get("Allow")}`
  );

  // 5. Invalid param -> 400
  const badRes = await fetch(`${baseUrl}/api/events?status=invalid_status`);
  assertCheck("GET /api/events?status=invalid -> 400", badRes.status === 400, badRes.status);

  // 6. SSRF defense -> 403
  const ssrfRes = await fetch(`${baseUrl}/api/proxy?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F`);
  assertCheck("GET /api/proxy SSRF 169.254.169.254 -> 403", ssrfRes.status === 403, ssrfRes.status);

  // 7. GET /api/openapi.json
  const openapiRes = await fetch(`${baseUrl}/api/openapi.json`);
  const openapiJson = (await openapiRes.json()) as { openapi?: string; paths?: Record<string, unknown> };
  const pathCount = Object.keys(openapiJson.paths ?? {}).length;
  assertCheck(
    "GET /api/openapi.json (3.1.0, 9 routes)",
    openapiRes.status === 200 && openapiJson.openapi === "3.1.0" && pathCount === 9,
    openapiRes.status,
    `paths=${pathCount}`
  );

  // 8. GET /api/facets
  const facetsRes = await fetch(`${baseUrl}/api/facets`);
  const facetsJson = (await facetsRes.json()) as {
    data?: { counts?: { live: number; upcoming: number; ended: number; active: number } };
  };
  assertCheck(
    "GET /api/facets",
    facetsRes.status === 200 && typeof facetsJson.data?.counts?.active === "number",
    facetsRes.status,
    `active=${facetsJson.data?.counts?.active ?? 0}, live=${facetsJson.data?.counts?.live ?? 0}`
  );

  // 9. GET /api/events
  const eventsRes = await fetch(`${baseUrl}/api/events?status=all&limit=10`);
  const eventsJson = (await eventsRes.json()) as {
    data?: Array<{ id: string; title: string; status: string; streamsUrl: string }>;
  };
  const firstEvent = eventsJson.data?.find((e) => e.status === "live") ?? eventsJson.data?.[0];
  assertCheck(
    "GET /api/events",
    eventsRes.status === 200 && Array.isArray(eventsJson.data) && eventsJson.data.length > 0,
    eventsRes.status,
    `count=${eventsJson.data?.length ?? 0}, sample=${firstEvent?.id ?? "none"}`
  );

  // 10. GET /api/events/:id + GET /api/stream/:id + optional live proxy check
  if (firstEvent) {
    const detailRes = await fetch(`${baseUrl}/api/events/${firstEvent.id}?inspect=false`);
    const detailJson = (await detailRes.json()) as {
      data?: { id: string; streams?: Array<{ proxyUrl: string; protocol: string }> };
    };
    assertCheck(
      "GET /api/events/:id",
      detailRes.status === 200 && detailJson.data?.id === firstEvent.id,
      detailRes.status,
      `streams=${detailJson.data?.streams?.length ?? 0}`
    );

    const streamRes = await fetch(`${baseUrl}/api/stream/${firstEvent.id}?inspect=false`);
    const streamJson = (await streamRes.json()) as {
      data?: { eventId: string; streams?: Array<{ proxyUrl: string; protocol: string }> };
    };
    assertCheck(
      "GET /api/stream/:id",
      streamRes.status === 200 && streamJson.data?.eventId === firstEvent.id,
      streamRes.status,
      `streams=${streamJson.data?.streams?.length ?? 0}`
    );

    const hlsStream = streamJson.data?.streams?.find((s) => s.protocol === "hls" && s.proxyUrl);
    if (hlsStream) {
      const proxyPath = hlsStream.proxyUrl.replace(/^https?:\/\/[^/]+/, "");
      const proxyRes = await fetch(`${baseUrl}${proxyPath}`, { method: "HEAD" });
      assertCheck(
        "HEAD /api/proxy (live HLS sample)",
        proxyRes.status >= 200 && proxyRes.status < 500,
        proxyRes.status,
        `ct=${proxyRes.headers.get("Content-Type") ?? "none"}`
      );
    }
  }

  // 11. GET /api/health & GET /api/metrics
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assertCheck(
    "GET /api/health (no-store)",
    healthRes.status === 200 && healthRes.headers.get("Cache-Control") === "no-store",
    healthRes.status
  );

  const metricsRes = await fetch(`${baseUrl}/api/metrics`);
  assertCheck(
    "GET /api/metrics (no-store)",
    metricsRes.status === 200 && metricsRes.headers.get("Cache-Control") === "no-store",
    metricsRes.status
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSmoke summary: ${results.length - failed.length}/${results.length} passed against ${baseUrl}`);
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
