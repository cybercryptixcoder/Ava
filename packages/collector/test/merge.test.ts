import { describe, expect, it } from "vitest";
import { cleanTitle, DEFAULT_PRIVATE_APPS, Merger, type MergeOptions } from "../src/merge";

const opts: MergeOptions = { intervalSeconds: 10, maxGapSeconds: 60, minActiveSeconds: 30, maxSessionMinutes: 30, sendTitles: true, privateApps: DEFAULT_PRIVATE_APPS };
const T0 = Date.parse("2026-10-05T14:00:00Z");
const at = (s: number) => T0 + s * 1000;

describe("collector merging", () => {
  it("merges consecutive samples of one window into one session", () => {
    const m = new Merger(opts);
    for (let s = 0; s < 60; s += 10) m.add({ at: at(s), app: "Code", title: "shell.c — os-project — Visual Studio Code", idle: false });
    m.add({ at: at(60), app: "Firefox", title: "Dijkstra - Wikipedia — Mozilla Firefox", idle: false });
    const [first] = m.take();
    expect(first).toEqual({ app: "Code", title: "shell.c — os-project", started_at: new Date(at(0)).toISOString(), ended_at: new Date(at(60)).toISOString(), active_seconds: 60 });
  });

  it("drops alt-tab noise and splits on idle and sleep", () => {
    const m = new Merger(opts);
    m.add({ at: at(0), app: "Slack", title: "general", idle: false });
    m.add({ at: at(10), app: "Code", title: "a.c", idle: false });
    expect(m.take()).toEqual([]); // 10 s of Slack is noise
    for (let s = 10; s < 50; s += 10) m.add({ at: at(s), app: "Code", title: "a.c", idle: false });
    m.add({ at: at(50), app: "Code", title: "a.c", idle: true });
    expect(m.take()).toHaveLength(1);
    for (let s = 100; s < 140; s += 10) m.add({ at: at(s), app: "Code", title: "a.c", idle: false });
    m.add({ at: at(3600), app: "Code", title: "a.c", idle: false }); // laptop slept
    const [s] = m.take();
    expect(s.ended_at).toBe(new Date(at(140)).toISOString());
  });

  it("cuts long sessions so they arrive while still going", () => {
    const m = new Merger({ ...opts, maxSessionMinutes: 5 });
    for (let s = 0; s <= 400; s += 10) m.add({ at: at(s), app: "Code", title: "a.c", idle: false });
    expect(m.take()).toHaveLength(1);
    expect(m.open).toBe(true);
  });

  it("never sends titles from private windows, password managers, or with titles off", () => {
    expect(cleanTitle("Firefox", "Bank — Mozilla Firefox Private Browsing", opts)).toBeUndefined();
    expect(cleanTitle("1Password 8", "Vault", opts)).toBeUndefined();
    expect(cleanTitle("Code", "a.c", { ...opts, sendTitles: false })).toBeUndefined();
    expect(cleanTitle("Slack", "(3) general - Slack", opts)).toBe("general - Slack");
  });
});
