import { afterEach, describe, expect, it } from "vitest";
import { seedTestProfile } from "../src/fixtures/seed";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp;
afterEach(() => t?.close());

describe("test profile", () => {
  it("seeds a realistic week and runs the morning for real on the simulated clock", async () => {
    t = makeApp();
    const at = await seedTestProfile(t.svc);
    expect(t.clock.now().toISOString()).toBe(at);
    const msgs = t.svc.messages.list({ limit: 50 });
    // The morning's wakes produced real, validated messages within the caps.
    const today = at.slice(0, 10);
    const sentToday = msgs.filter((m) => m.status === "sent" && m.sent_at?.startsWith(today));
    expect(sentToday.length).toBeGreaterThan(0);
    expect(sentToday.length).toBeLessThanOrEqual(3);
    expect(t.svc.counters.get("messages.unprompted")).toBe(sentToday.length);
    expect(t.svc.db.get("SELECT id FROM briefs LIMIT 1")).toBeTruthy();
    const rules = t.svc.rules.list();
    expect(rules.proposed.length).toBeGreaterThan(0);
    expect(rules.dynamic.some((r) => r.status === "paused_low_precision")).toBe(true);
    // Every sent message cites real items and names its rule.
    for (const m of msgs.filter((x) => x.status === "sent")) {
      expect(m.cited.length).toBeGreaterThan(0);
      for (const c of m.cited) expect(t.svc.items.get(c.id)?.title).toBe(c.title);
      expect(m.rule_id).toBeTruthy();
    }
  });
});
