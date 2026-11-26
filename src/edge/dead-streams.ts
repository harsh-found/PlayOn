const DEFAULT_COOLDOWN_MS = 150_000;
const DEFAULT_MAX_ENTRIES = 512;

function normalizeTrackingKey(rawUrl: string): string {
  const qIdx = rawUrl.indexOf("?");
  if (qIdx === -1) return rawUrl;
  const hIdx = rawUrl.indexOf("#", qIdx + 1);
  const base = rawUrl.slice(0, qIdx);
  const query = rawUrl.slice(qIdx + 1, hIdx === -1 ? rawUrl.length : hIdx);
  const kept: string[] = [];
  for (let pos = 0, len = query.length; pos < len;) {
    let amp = query.indexOf("&", pos);
    if (amp === -1) amp = len;
    const eq = query.indexOf("=", pos);
    const k = (eq > pos && eq < amp ? query.slice(pos, eq) : query.slice(pos, amp)).toLowerCase();
    if (k && k !== "token" && k !== "hdnts" && k !== "hdnea" && k !== "exp" && k !== "expires" && k !== "sig" && k !== "hmac" && k !== "auth" && k !== "ts" && k !== "t") {
      kept.push(query.slice(pos, amp));
    }
    pos = amp + 1;
  }
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

export class DeadStreamTracker {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  recordFailure(rawUrl: string, nowMs = Date.now()): void {
    const key = normalizeTrackingKey(rawUrl);
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, nowMs + this.cooldownMs);
  }

  recordSuccess(rawUrl: string): void {
    this.entries.delete(normalizeTrackingKey(rawUrl));
  }

  isDemoted(rawUrl: string, nowMs = Date.now()): boolean {
    const key = normalizeTrackingKey(rawUrl);
    const exp = this.entries.get(key);
    if (exp === undefined) return false;
    if (exp <= nowMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
