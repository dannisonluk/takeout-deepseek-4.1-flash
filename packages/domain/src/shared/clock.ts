/**
 * Time is a dependency, not a global.
 *
 * Every domain service that needs "now" receives a `Clock`. This makes
 * time-dependent rules (order expiry, prep-time feasibility, dispatch scoring)
 * deterministic under test without monkey-patching `Date`.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test double: a clock you can advance explicitly. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string | Date) {
    this.current = typeof iso === 'string' ? new Date(iso) : new Date(iso.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  set(iso: string | Date): void {
    this.current = typeof iso === 'string' ? new Date(iso) : new Date(iso.getTime());
  }
}
