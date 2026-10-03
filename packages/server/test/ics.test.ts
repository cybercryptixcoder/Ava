import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

/** A weekly MWF class, one cancelled week, one moved instance — across the DST change (Nov 1). */
const FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Ava test//EN
BEGIN:VEVENT
UID:class-1
SUMMARY:CMPSC 465 lecture
DTSTART;TZID=America/New_York:20261019T101000
DTEND;TZID=America/New_York:20261019T112500
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261117T030000Z
EXDATE;TZID=America/New_York:20261109T101000
LOCATION:Willard 076
DESCRIPTION:Data Structures and Algorithms
END:VEVENT
BEGIN:VEVENT
UID:class-1
RECURRENCE-ID;TZID=America/New_York:20261021T101000
DTSTART;TZID=America/New_York:20261021T140000
DTEND;TZID=America/New_York:20261021T151500
SUMMARY:CMPSC 465 lecture (moved)
END:VEVENT
END:VCALENDAR
`;

describe("ICS feeds", () => {
  it("expands recurring events into occurrences, with exclusions, overrides and the DST change", async () => {
    t = makeApp({ at: atLocal("2026-10-17", "09:00", NY).toISOString() });
    t.svc.db.run("INSERT INTO ics_feeds (id, label, url_enc, kind, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)", [
      "fixture",
      "CMPSC 465 (feed)",
      "-",
      "course",
      t.clock.now().toISOString(),
    ]);
    await t.svc.sources.ics.syncFeed("fixture", null, FEED);
    const events = t.svc.items
      .list({ types: ["event"] })
      .filter((i) => i.source === "ics:fixture")
      .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));
    // Thirteen raw occurrences minus the excluded week.
    expect(events).toHaveLength(12);
    const starts = events.map((e) => e.start_at);
    // The time zone holds across the DST change: 10:10 local, 14:10Z before and 15:10Z after.
    expect(starts).toContain(atLocal("2026-10-26", "10:10", NY).toISOString());
    expect(starts).toContain(atLocal("2026-11-02", "10:10", NY).toISOString());
    expect(starts).toContain(atLocal("2026-11-16", "10:10", NY).toISOString());
    // The excluded week is missing…
    expect(starts).not.toContain(atLocal("2026-11-09", "10:10", NY).toISOString());
    // …and the moved instance sits at its new time, with its new title; its old slot is empty.
    const moved = events.find((e) => e.title.includes("(moved)"));
    expect(moved?.start_at).toBe(atLocal("2026-10-21", "14:00", NY).toISOString());
    expect(starts).not.toContain(atLocal("2026-10-21", "10:10", NY).toISOString());
  });
});
