// Screenshots of every screen, phone and desktop, light and dark.
// Run against a server on the test profile:
//   npm run build && AVA_PROFILE=test PORT=4318 npm run start:prod   (in one terminal)
//   npm run screenshots -- --base=http://127.0.0.1:4318              (in another)
// Output: docs/screenshots/<screen>-<device>-<theme>.png
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const base = arg("base", "http://127.0.0.1:4318");
const out = path.resolve(arg("out", "docs/screenshots"));
const only = arg("only", "");
fs.mkdirSync(out, { recursive: true });

const SCREENS = [
  { name: "today", path: "/today" },
  { name: "talk", path: "/talk" },
  { name: "tasks", path: "/tasks" },
  { name: "rules", path: "/rules" },
  { name: "knows", path: "/knows" },
  { name: "messages", path: "/messages" },
  { name: "log", path: "/log" },
  { name: "settings", path: "/settings" },
  { name: "setup", path: "/setup" },
].filter((s) => !only || only.split(",").includes(s.name));

const DEVICES = [
  { name: "phone", viewport: { width: 390, height: 844 }, scale: 2, mobile: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, scale: 1, mobile: false },
];

// Use a preinstalled Chromium when one is provided (CHROMIUM_PATH), else Playwright's own.
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const d of DEVICES) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.scale, isMobile: d.mobile, hasTouch: d.mobile, reducedMotion: "reduce", colorScheme: theme });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("ava.theme", t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    for (const s of SCREENS) {
      await page.goto(base + s.path, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const file = path.join(out, `${s.name}-${d.name}-${theme}.png`);
      // Phones: what you see on opening the screen. Desktop: the whole page (Talk scrolls inside its panes).
      await page.screenshot({ path: file, fullPage: d.name === "desktop" && s.name !== "talk" });
      console.log(path.relative(process.cwd(), file));
    }
    await ctx.close();
  }
}
await browser.close();
