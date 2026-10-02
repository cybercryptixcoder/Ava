/**
 * The system owns time. Everything that asks "what time is it" goes through
 * a Clock so the test profile can fast-forward days in minutes.
 */
export interface Clock {
  now(): Date;
  readonly simulated: boolean;
}

export class RealClock implements Clock {
  readonly simulated = false;
  now(): Date {
    return new Date();
  }
}

/** A clock that stands still until told to move. Only used on the test profile and in tests. */
export class SimClock implements Clock {
  readonly simulated = true;
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
  advance(ms: number): Date {
    this.t += ms;
    return this.now();
  }
}

export const iso = (d: Date): string => d.toISOString();
export const addMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);
export const addHours = (d: Date, h: number): Date => new Date(d.getTime() + h * 3_600_000);
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
