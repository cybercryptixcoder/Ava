import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./lib/api";
import { refetchAll, startEvents, useApi, useServerEvents } from "./lib/store";
import { placeTime, setTimeContext } from "./lib/time";
import { applyTheme } from "./lib/theme";
import { registerServiceWorker } from "./lib/push";
import { Sheet } from "./components/ui";
import { Login } from "./screens/Login";
import { Today } from "./screens/Today";
import { Talk } from "./screens/Talk";
import { Tasks } from "./screens/Tasks";
import { Rules } from "./screens/Rules";
import { Knows } from "./screens/Knows";
import { Messages } from "./screens/Messages";
import { Log } from "./screens/Log";
import { Settings } from "./screens/Settings";
import { FirstRun } from "./screens/FirstRun";

interface Me {
  authenticated: boolean;
  password_set: boolean;
  profile: "real" | "test";
  owner: string;
}
interface SettingsResp {
  settings: { locations: { id: string; label: string; tz: string }[]; current_location_id: string; first_run_complete: boolean };
  location: { id: string; label: string; tz: string };
}

const NAV = [
  { to: "/today", label: "Today" },
  { to: "/talk", label: "Talk" },
  { to: "/tasks", label: "Tasks and projects" },
  { to: "/rules", label: "Rules" },
  { to: "/knows", label: "What Ava knows" },
  { to: "/messages", label: "Messages" },
  { to: "/log", label: "Log" },
  { to: "/settings", label: "Settings" },
];

export function LocationSwitch({ compact }: { compact?: boolean }) {
  const { data } = useApi<SettingsResp>("/api/settings");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (!data) return <div className="dualtime" aria-busy="true" />;
  const switchTo = async (id: string) => {
    if (id === data.settings.current_location_id) return;
    await api.post("/api/settings/location", { id });
    refetchAll();
  };
  return (
    <div className={`dualtime${compact ? " dualtime-compact" : ""}`} role="radiogroup" aria-label="Where you are">
      {data.settings.locations.map((l) => {
        const active = l.id === data.settings.current_location_id;
        return (
          <button key={l.id} type="button" role="radio" aria-checked={active} className="dualtime-place" onClick={() => void switchTo(l.id)} title={active ? `You're in ${l.label}` : `Switch to ${l.label}; every schedule moves to ${l.tz}`}>
            <span className="dualtime-name">{l.label}</span>
            <span className="dualtime-time num">{placeTime(l.tz)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Frame({ me }: { me: Me }) {
  const loc = useLocation();
  const [more, setMore] = useState(false);
  const { data: settings } = useApi<SettingsResp>("/api/settings");
  const { data: clock } = useApi<{ now: string; tz: string; simulated: boolean }>("/api/dev/clock");
  if (clock) setTimeContext(clock.tz, clock.now);
  else if (settings) setTimeContext(settings.location.tz);
  useEffect(() => {
    applyTheme();
    const t = window.setInterval(applyTheme, 60_000);
    return () => window.clearInterval(t);
  }, [clock?.now, settings?.location.tz]);
  useServerEvents((e) => {
    if (e.type === "clock.changed") void refetchAll();
  });
  useEffect(() => setMore(false), [loc.pathname]);
  if (settings && !settings.settings.first_run_complete && loc.pathname !== "/setup" && me.profile === "real") return <Navigate to="/setup" replace />;
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Screens">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden="true" />
          <span className="rail-name">Ava</span>
          {me.profile === "test" ? <span className="rail-profile">Test profile</span> : null}
        </div>
        <LocationSwitch />
        <ul className="rail-nav">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className="navlink">
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        {clock?.simulated ? <p className="rail-sim">Simulated clock</p> : null}
      </nav>
      <main className="main" id="main">
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/today" element={<Today />} />
          <Route path="/talk" element={<Talk />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/knows" element={<Knows />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/log" element={<Log />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<FirstRun />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Screens">
        {NAV.slice(0, 3).map((n) => (
          <NavLink key={n.to} to={n.to} className="tab">
            {n.to === "/tasks" ? "Tasks" : n.label}
          </NavLink>
        ))}
        <NavLink to="/messages" className="tab">
          Messages
        </NavLink>
        <button type="button" className="tab" aria-expanded={more} onClick={() => setMore(true)} data-active={["/rules", "/knows", "/log", "/settings"].includes(loc.pathname) || undefined}>
          More
        </button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <ul className="more-list">
          {NAV.slice(3)
            .filter((n) => n.to !== "/messages")
            .map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} className="more-link">
                  {n.label}
                </NavLink>
              </li>
            ))}
        </ul>
      </Sheet>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const check = () =>
    void api
      .get<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setMe({ authenticated: false, password_set: true, profile: "real", owner: "" }));
  useEffect(() => {
    applyTheme();
    check();
    void registerServiceWorker();
    const onUnauth = () => setMe((m) => (m ? { ...m, authenticated: false } : m));
    window.addEventListener("ava:unauthorized", onUnauth);
    return () => window.removeEventListener("ava:unauthorized", onUnauth);
  }, []);
  useEffect(() => {
    if (me?.authenticated) startEvents();
  }, [me?.authenticated]);
  if (!me) return <div className="boot" aria-busy="true" />;
  if (!me.authenticated) return <Login passwordSet={me.password_set} onDone={check} />;
  return (
    <BrowserRouter>
      <Frame me={me} />
    </BrowserRouter>
  );
}
