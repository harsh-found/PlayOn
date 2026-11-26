export type SubrequestKind = "critical" | "hedge" | "probe";

export const DEFAULT_MAX_SUBREQUESTS = 42;
const SOFT_HEDGE_LIMIT = 30;
const SOFT_PROBE_LIMIT = 34;

export class RequestBudget {
  private count = 0;

  constructor(private readonly maxTotal = DEFAULT_MAX_SUBREQUESTS) {}

  get used(): number {
    return this.count;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this.count);
  }

  canAcquire(kind: SubrequestKind): boolean {
    if (this.count >= this.maxTotal) return false;
    if (kind === "hedge" && this.count >= SOFT_HEDGE_LIMIT) return false;
    if (kind === "probe" && this.count >= SOFT_PROBE_LIMIT) return false;
    return true;
  }

  tryAcquire(kind: SubrequestKind): boolean {
    if (!this.canAcquire(kind)) return false;
    this.count++;
    return true;
  }
}
