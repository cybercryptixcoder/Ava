import { DateTime } from "luxon";
import { now, tz } from "./time";

export type ThemePref = "auto" | "light" | "dark";
const KEY = "ava.theme";

export function getPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setPref(p: ThemePref): void {
  try {
    if (p === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* storage unavailable */
  }
  applyTheme();
}

/** Dark from 19:00 to 07:00 in his current time zone, unless overridden. */
export function resolvedTheme(): "light" | "dark" {
  const p = getPref();
  if (p !== "auto") return p;
  const h = DateTime.fromJSDate(now()).setZone(tz()).hour;
  return h >= 19 || h < 7 ? "dark" : "light";
}

export function applyTheme(): void {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') ?? (() => {
    const m = document.createElement("meta");
    m.name = "theme-color";
    document.head.appendChild(m);
    return m;
  })();
  meta.setAttribute("content", t === "dark" ? "#171A1F" : "#F3F4F2");
}
