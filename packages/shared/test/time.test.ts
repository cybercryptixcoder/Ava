import { describe, expect, it } from "vitest";
import { atLocal, calendarDaysUntil, formatClock, inQuietHours, nextWakingInstant, spanPhrase } from "../src/time";

describe("time helpers", () => {
  it("detects quiet hours that wrap midnight, in the right zone", () => {
    const ny = "America/New_York";
    expect(inQuietHours(atLocal("2026-10-05", "23:30", ny), ny, "23:00", "08:00")).toBe(true);
    expect(inQuietHours(atLocal("2026-10-06", "07:59", ny), ny, "23:00", "08:00")).toBe(true);
    expect(inQuietHours(atLocal("2026-10-06", "08:00", ny), ny, "23:00", "08:00")).toBe(false);
    // 23:30 in New York is 09:00 next day in Bangalore: not quiet there.
    expect(inQuietHours(atLocal("2026-10-05", "23:30", ny), "Asia/Kolkata", "23:00", "08:00")).toBe(false);
  });

  it("finds the next waking moment", () => {
    const ny = "America/New_York";
    const next = nextWakingInstant(atLocal("2026-10-05", "23:30", ny), ny, "23:00", "08:00");
    expect(next.toISOString()).toBe(atLocal("2026-10-06", "08:00", ny).toISOString());
  });

  it("formats clocks and spans as spoken", () => {
    expect(formatClock("2026-10-05T17:05:00Z", "America/New_York")).toBe("1:05 pm");
    expect(formatClock("2026-10-05T17:00:00Z", "America/New_York")).toBe("1 pm");
    expect(spanPhrase(45)).toBe("45 minutes");
    expect(spanPhrase(240)).toBe("4 hours");
    expect(spanPhrase(150)).toBe("2 hours 30 minutes");
  });

  it("counts calendar days in the local zone", () => {
    const ny = "America/New_York";
    expect(calendarDaysUntil(atLocal("2026-10-05", "23:00", ny), atLocal("2026-10-06", "09:00", ny), ny)).toBe(1);
  });
});
