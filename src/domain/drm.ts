import type { StreamDrm } from "../types";

const HEX32 = /^[0-9a-fA-F]{32}$/;
const CLEARKEY_INLINE_RE = /(?:clearkey[:=]\s*|(?:keyId|kid)=)([0-9a-fA-F]{32})(?:[:=]|.*?key=)([0-9a-fA-F]{32})/i;
const WIDEVINE_RE = /\bwidevine\b/i;

export class DrmDetector {
  static parseClearKeyString(raw: string): Array<{ kid: string; key: string }> {
    const s = raw.charCodeAt(0) <= 32 || raw.charCodeAt(raw.length - 1) <= 32 ? raw.trim() : raw;
    if (s.length === 65 && (s.charCodeAt(32) === 58 || s.charCodeAt(32) === 61)) {
      const k1 = s.slice(0, 32), k2 = s.slice(33);
      if (HEX32.test(k1) && HEX32.test(k2)) return [{ kid: k1.toLowerCase(), key: k2.toLowerCase() }];
    }
    const entries: Array<{ kid: string; key: string }> = [];
    for (const pair of s.split(/[,;]+/)) {
      const [kid, key, extra] = pair.trim().split(/[:=]/);
      if (!extra && kid && key && HEX32.test(kid) && HEX32.test(key)) entries.push({ kid: kid.toLowerCase(), key: key.toLowerCase() });
    }
    return entries;
  }

  static detect(text: string, explicitClearkey?: string, parsedUrlOrParam?: URL | string | null): StreamDrm | null {
    const direct = explicitClearkey?.trim() || (typeof parsedUrlOrParam === "string" ? parsedUrlOrParam : parsedUrlOrParam?.searchParams.get("clearkey")) || "";
    if (direct) { const keys = this.parseClearKeyString(direct); if (keys.length > 0) return { scheme: "clearkey", keys }; }
    if (!text) return null;
    const lower = text.toLowerCase();
    if (!lower.includes("clearkey") && !lower.includes("kid=") && !lower.includes("keyid=") && !lower.includes("widevine")) return null;
    let decoded = text;
    if (text.includes("%")) { try { decoded = decodeURIComponent(text); } catch { decoded = text; } }
    const m = CLEARKEY_INLINE_RE.exec(decoded);
    if (m?.[1] && m[2]) return { scheme: "clearkey", keys: [{ kid: m[1].toLowerCase(), key: m[2].toLowerCase() }] };
    if (lower.includes("clearkey")) return { scheme: "clearkey" };
    return WIDEVINE_RE.test(decoded) ? { scheme: "widevine" } : null;
  }
}
