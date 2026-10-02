import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RawSample {
  app: string;
  title: string;
  idleSeconds: number | null;
}

/** Reads the frontmost app, its window title and how long input has been idle. */
export interface Sampler {
  readonly name: string;
  sample(): Promise<RawSample | null>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// macOS: System Events via osascript (needs Accessibility permission for
// window titles; without it, titles come back empty and only apps are sent).
// Idle time from IOKit's HIDIdleTime.
// ---------------------------------------------------------------------------

const MAC_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  try
    set winTitle to name of front window of frontApp
  end try
end tell
return appName & linefeed & winTitle`;

class MacSampler implements Sampler {
  readonly name = "macOS (System Events)";
  async sample(): Promise<RawSample | null> {
    const [front, idle] = await Promise.all([run("osascript", ["-e", MAC_SCRIPT], { timeout: 5000 }), run("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).catch(() => null)]);
    const [app, ...rest] = front.stdout.replace(/\n$/, "").split("\n");
    const m = idle?.stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return { app: app.trim(), title: rest.join(" ").trim(), idleSeconds: m ? Number(m[1]) / 1e9 : null };
  }
  stop(): void {}
}

// ---------------------------------------------------------------------------
// Windows: one long-running PowerShell process that prints a JSON line per
// request, using user32 (GetForegroundWindow, GetWindowText,
// GetLastInputInfo). Starting PowerShell per sample would be slow.
// ---------------------------------------------------------------------------

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AvaWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
}
"@
while ($true) {
  $null = [Console]::In.ReadLine()
  $h = [AvaWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  $null = [AvaWin]::GetWindowText($h, $sb, 512)
  $procId = 0
  $null = [AvaWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId
  $app = if ($p.MainModule.FileVersionInfo.FileDescription) { $p.MainModule.FileVersionInfo.FileDescription } else { $p.ProcessName }
  $li = New-Object AvaWin+LASTINPUTINFO
  $li.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($li)
  $null = [AvaWin]::GetLastInputInfo([ref]$li)
  $idle = ([Environment]::TickCount - $li.dwTime) / 1000
  [Console]::Out.WriteLine((@{ app = "$app"; title = $sb.ToString(); idle = $idle } | ConvertTo-Json -Compress))
}`;

class WindowsSampler implements Sampler {
  readonly name = "Windows (user32 via PowerShell)";
  private ps: ChildProcess;
  private buf = "";
  private waiting: ((line: string | null) => void)[] = [];

  constructor() {
    this.ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.ps.stdin!.write(`${WIN_SCRIPT}\n`);
    this.ps.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line.startsWith("{")) this.waiting.shift()?.(line);
      }
    });
    this.ps.on("exit", () => this.waiting.splice(0).forEach((w) => w(null)));
  }

  sample(): Promise<RawSample | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      this.waiting.push((line) => {
        clearTimeout(timer);
        if (!line) return resolve(null);
        try {
          const j = JSON.parse(line) as { app: string; title: string; idle: number };
          resolve({ app: j.app || "Unknown", title: j.title ?? "", idleSeconds: j.idle });
        } catch {
          resolve(null);
        }
      });
      this.ps.stdin!.write("\n");
    });
  }

  stop(): void {
    this.ps.kill();
  }
}

// ---------------------------------------------------------------------------
// Linux on X11 (and XWayland apps): xdotool for the active window, its PID's
// process name from /proc, xprintidle for idle time if installed. Pure
// Wayland sessions don't expose the focused window to other programs, so
// the collector says so instead of guessing.
// ---------------------------------------------------------------------------

class LinuxSampler implements Sampler {
  readonly name = "Linux (X11 via xdotool)";
  async sample(): Promise<RawSample | null> {
    // _NET_ACTIVE_WINDOW from the window manager; minimal WMs only report input focus.
    const id = (
      await run("xdotool", ["getactivewindow"], { timeout: 3000 }).catch(() => run("xdotool", ["getwindowfocus", "-f"], { timeout: 3000 }))
    ).stdout.trim();
    if (!id) return null;
    const [title, pid] = await Promise.all([
      run("xdotool", ["getwindowname", id], { timeout: 3000 }).then((r) => r.stdout.trim()),
      run("xdotool", ["getwindowpid", id], { timeout: 3000 })
        .then((r) => r.stdout.trim())
        .catch(() => ""),
    ]);
    let app = "Unknown";
    if (pid) {
      try {
        app = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {
        /* process gone */
      }
    }
    const idle = await run("xprintidle", [], { timeout: 3000 })
      .then((r) => Number(r.stdout.trim()) / 1000)
      .catch(() => null);
    return { app, title, idleSeconds: idle };
  }
  stop(): void {}
}

export async function createSampler(): Promise<Sampler> {
  switch (process.platform) {
    case "darwin":
      return new MacSampler();
    case "win32":
      return new WindowsSampler();
    case "linux": {
      if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
        throw new Error("This is a Wayland session without X11. Wayland doesn't let other programs read the focused window, so the collector can't run here. Log in with an X11 session, or skip laptop activity.");
      }
      try {
        await run("xdotool", ["--version"], { timeout: 3000 });
      } catch {
        throw new Error("xdotool isn't installed. Install it (for example `sudo apt install xdotool xprintidle`) and try again.");
      }
      return new LinuxSampler();
    }
    default:
      throw new Error(`The collector doesn't support ${process.platform}.`);
  }
}
