export const DEFAULT_PROXY_SIG_TTL_SEC = 21_600;
const keyCache = new Map<string, Promise<CryptoKey>>();
const TEXT_ENCODER = new TextEncoder();

export interface ProxySignParams { url: string; referer?: string | null; origin?: string | null; ua?: string | null; rewrite: boolean; hls?: boolean; rep?: string | null; }

export function resolveProxySigTtlSec(raw?: string): number {
  const n = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(n) ? Math.max(30, Math.min(86_400, n)) : DEFAULT_PROXY_SIG_TTL_SEC;
}

function getHmacKey(secret: string): Promise<CryptoKey> {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  if (keyCache.size >= 8) keyCache.clear();
  const pending = crypto.subtle.importKey("raw", TEXT_ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  keyCache.set(secret, pending);
  return pending;
}

export async function signProxyPayload(params: ProxySignParams, expSec: number, secret: string): Promise<string> {
  const hlsPart = params.hls ? `\n1\n${params.rep ?? ""}` : "";
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await getHmacKey(secret), TEXT_ENCODER.encode(`${params.url}\n${params.referer ?? ""}\n${params.origin ?? ""}\n${params.ua ?? ""}\n${params.rewrite ? "1" : "0"}\n${expSec}${hlsPart}`)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function buildSignedProxyUrl(proxyOrigin: string, params: ProxySignParams, secret: string, expSec: number): Promise<string> {
  const sig = await signProxyPayload(params, expSec, secret);
  return `${proxyOrigin}/api/proxy?url=${encodeURIComponent(params.url)}${params.referer ? `&referer=${encodeURIComponent(params.referer)}` : ""}${params.origin ? `&origin=${encodeURIComponent(params.origin)}` : ""}${params.ua ? `&ua=${encodeURIComponent(params.ua)}` : ""}${params.rewrite ? "" : "&rewrite=false"}${params.hls ? "&hls=1" : ""}${params.hls && params.rep ? `&rep=${encodeURIComponent(params.rep)}` : ""}&exp=${expSec}&sig=${sig}`;
}

export async function verifySignedProxyParams(
  params: ProxySignParams, rawExp: string | null, rawSig: string | null, secret: string, nowMs?: number
): Promise<{ ok: true } | { ok: false; code: "MISSING_SIGNATURE" | "EXPIRED_SIGNATURE" | "INVALID_SIGNATURE"; detail: string }> {
  if (!rawExp || !rawSig) return { ok: false, code: "MISSING_SIGNATURE", detail: "Signed proxy URL required (missing exp or sig)." };
  const expTrim = rawExp.trim();
  if (!/^\d{10,13}$/.test(expTrim)) return { ok: false, code: "INVALID_SIGNATURE", detail: "Malformed proxy signature expiration." };
  const expSec = Number.parseInt(expTrim, 10);
  if (!Number.isFinite(expSec) || expSec * 1000 <= (nowMs ?? Date.now())) return { ok: false, code: "EXPIRED_SIGNATURE", detail: "Proxy URL signature has expired." };
  const a = TEXT_ENCODER.encode(rawSig.trim()), b = TEXT_ENCODER.encode(await signProxyPayload(params, expSec, secret));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 ? { ok: true } : { ok: false, code: "INVALID_SIGNATURE", detail: "Invalid proxy URL signature." };
}
