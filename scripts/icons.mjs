// Renders the PWA's PNG icons from public/icon.svg (run after changing the icon).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const pub = path.resolve("packages/web/public");
const svg = fs.readFileSync(path.join(pub, "icon.svg"), "utf8");
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();

async function render(file, size, maskable) {
  // Maskable icons are full-bleed with the dial inside the 80% safe zone.
  const inner = maskable ? svg.replace('rx="112"', 'rx="0"').replace("<g ", '<g transform="translate(51.2 51.2) scale(0.8)" ').replace(/<line x1="256" y1="256"/g, '<line transform="translate(51.2 51.2) scale(0.8)" x1="256" y1="256"').replace("<circle ", '<circle transform="translate(51.2 51.2) scale(0.8)" ') : svg;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${inner.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(pub, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(file);
}

await render("icon-192.png", 192, false);
await render("icon-512.png", 512, false);
await render("icon-maskable-512.png", 512, true);
await browser.close();
