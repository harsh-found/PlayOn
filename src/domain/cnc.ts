import type { CatalogExclusion, CncDecodedPayload, UpstreamMeta, UpstreamStream } from "../types";

export const MAX_CNC_RAW_ID_LENGTH = 16 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_SCRATCH = new Uint8Array(MAX_CNC_RAW_ID_LENGTH);
const NON_ASCII_RE = /[^\x00-\x7f]/;

function decodeUtf8Binary(bin: string): string {
  if (!NON_ASCII_RE.test(bin)) return bin;
  const len = bin.length;
  const buf = len <= UTF8_SCRATCH.length ? UTF8_SCRATCH : new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
  return UTF8_DECODER.decode(len <= UTF8_SCRATCH.length ? buf.subarray(0, len) : buf);
}

function decodeCncParts(rawId: string): { bin: string; braceIdx: number } | null {
  if (!rawId || rawId.length > MAX_CNC_RAW_ID_LENGTH || !rawId.startsWith("cnc:")) return null;
  const rawB64 = rawId.slice(4);
  let bin: string;
  try {
    bin = atob(rawB64);
  } catch {
    const b64 = rawB64.replace(/-/g, "+").replace(/_/g, "/");
    const rem = b64.length & 3;
    try {
      bin = atob(rem ? b64 + "===".slice(0, 4 - rem) : b64);
    } catch {
      return null;
    }
  }
  const braceIdx = bin.indexOf("{");
  return braceIdx >= 2 && bin.charCodeAt(braceIdx - 1) === 58 ? { bin, braceIdx } : null;
}

function decodeCncJson(bin: string, braceIdx: number): CncDecodedPayload["data"] | null {
  try {
    const parsed: unknown = JSON.parse(decodeUtf8Binary(bin.slice(braceIdx)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CncDecodedPayload["data"])
      : null;
  } catch {
    return null;
  }
}

export function decodeCncPayloadData(rawId: string): CncDecodedPayload["data"] | null {
  const parts = decodeCncParts(rawId);
  return parts ? decodeCncJson(parts.bin, parts.braceIdx) : null;
}

export function decodeCncRawId(rawId: string): CncDecodedPayload | null {
  const parts = decodeCncParts(rawId);
  if (!parts) return null;
  let provEnd = parts.braceIdx - 1;
  while (provEnd > 0 && parts.bin.charCodeAt(provEnd - 1) === 58) provEnd--;
  const provider = parts.bin.slice(0, provEnd).trim();
  const data = provider ? decodeCncJson(parts.bin, parts.braceIdx) : null;
  return data ? { provider, data } : null;
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function validateUpstreamMetasWithAudit(
  provider: string,
  payload: unknown
): { items: UpstreamMeta[]; rawCount: number; exclusions: CatalogExclusion[] } {
  const exclusions: CatalogExclusion[] = [];
  const metas = payload && typeof payload === "object" ? (payload as { metas?: unknown }).metas : undefined;
  if (!Array.isArray(metas)) {
    exclusions.push({
      reason: "INVALID_ARRAY",
      provider,
      details: payload && typeof payload === "object" ? "Missing metas array" : "Payload is not an object",
    });
    return { items: [], rawCount: 0, exclusions };
  }
  const items: UpstreamMeta[] = [];
  for (let i = 0; i < metas.length; i++) {
    const raw: unknown = metas[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      exclusions.push({ reason: "NON_OBJECT", provider, details: `Index ${i}` });
      continue;
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id.trim()) {
      exclusions.push({ reason: "MISSING_ID", provider, details: `Index ${i}` });
      continue;
    }
    items.push({
      id: obj.id,
      type: optStr(obj.type),
      name: optStr(obj.name),
      poster: optStr(obj.poster),
      background: optStr(obj.background),
    });
  }
  return { items, rawCount: metas.length, exclusions };
}

export function validateUpstreamStreams(payload: unknown): UpstreamStream[] {
  const rawStreams = payload && typeof payload === "object" ? (payload as { streams?: unknown }).streams : undefined;
  if (!Array.isArray(rawStreams)) return [];
  const out: UpstreamStream[] = [];
  for (const raw of rawStreams) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    out.push({
      url: optStr(s.url) ?? "",
      externalUrl: optStr(s.externalUrl),
      name: optStr(s.name),
      title: optStr(s.title),
      clearkey: optStr(s.clearkey),
      behaviorHints:
        s.behaviorHints && typeof s.behaviorHints === "object" && !Array.isArray(s.behaviorHints)
          ? (s.behaviorHints as UpstreamStream["behaviorHints"])
          : undefined,
    });
  }
  return out;
}
