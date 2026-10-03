// Screenshots of every screen, phone and desktop, light and dark.
// Run against a server on the test profile:
//   npm run build && AVA_PROFILE=test PORT=4318 npm run start:prod   (in one terminal)
//   npm run screenshots -- --base=http://127.0.0.1:4318              (in another)
// Output: docs/screenshots/<screen>-<device>-<theme>.png
//
// The all-clear state can't exist while cards wait, so it is captured in a
// second pass: everything else first, then the cards are answered "not now"
// through the API once, then the empty-stack screenshots.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const base = arg("base", "http://127.0.0.1:4318");
const out = path.resolve(arg("out", "docs/screenshots"));
const only = arg("only", "");
fs.mkdirSync(out, { recursive: true });

const SCREENS = [
  { name: "stack", path: "/" },
  {
    name: "stack-layer",
    path: "/",
    fullPage: false,
    prepare: async (page) => {
      await page.locator(".stack-front").first().focus();
      await page.keyboard.press("Enter");
      await page.locator(".sheet").first().waitFor({ state: "visible" });
      await page.waitForTimeout(350);
    },
  },
  {
    name: "menu",
    path: "/",
    fullPage: false,
    prepare: async (page) => {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.locator(".sheet").first().waitFor({ state: "visible" });
      await page.waitForTimeout(250);
    },
  },
  { name: "calendar", path: "/calendar" },
  {
    name: "calendar-week",
    path: "/calendar",
    prepare: async (page) => {
      await page.getByRole("radio", { name: "Week" }).click();
      await page.waitForTimeout(350);
    },
  },
  { name: "everything", path: "/everything" },
  { name: "tasks", path: "/tasks" },
  { name: "rules", path: "/rules" },
  { name: "knows", path: "/knows" },
  { name: "memory", path: "/memory" },
  { name: "messages", path: "/messages" },
  { name: "log", path: "/log" },
  { name: "settings", path: "/settings" },
  { name: "setup", path: "/setup" },
].filter((s) => !only || only.split(",").includes(s.name));

const CLEAR_SCREENS = [{ name: "stack-clear", path: "/" }].filter((s) => !only || only.split(",").includes(s.name));

const DEVICES = [
  { name: "phone", viewport: { width: 390, height: 844 }, scale: 2, mobile: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, scale: 1, mobile: false },
];

// Use a preinstalled Chromium when one is provided (CHROMIUM_PATH), else Playwright's own.
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});

const shoot = async (d, theme, screens) => {
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.scale, isMobile: d.mobile, hasTouch: d.mobile, reducedMotion: "reduce", colorScheme: theme });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("ava.theme", t);
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  for (const s of screens) {
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    if (s.prepare) await s.prepare(page);
    const file = path.join(out, `${s.name}-${d.name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: s.fullPage ?? (d.name === "desktop" && s.name !== "stack" && s.name !== "menu") });
    console.log(path.relative(process.cwd(), file));
  }
  await ctx.close();
};

// Pass 1: everything while the stack still has its cards.
for (const d of DEVICES) for (const theme of ["light", "dark"]) await shoot(d, theme, SCREENS);

// Answer every card "not now" once, so the second pass finds an empty stack.
if (CLEAR_SCREENS.length) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  for (let i = 0; i < 12; i++) {
    const stack = await page.evaluate(async () => (await fetch("/api/stack", { credentials: "include" })).json());
    if (!stack.cards?.length) break;
    for (const c of stack.cards) {
      await page.evaluate(
        async (id) => fetch(`/api/cards/${id}/respond`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: "not_now" }) }),
        c.id,
      );
    }
  }
  await ctx.close();
  for (const d of DEVICES) for (const theme of ["light", "dark"]) await shoot(d, theme, CLEAR_SCREENS);
}

await browser.close();
