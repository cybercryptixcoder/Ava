import { useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./lib/api";
import { refetchAll, startEvents, useApi, useServerEvents } from "./lib/store";
import { setTimeContext } from "./lib/time";
import { applyTheme } from "./lib/theme";
import { registerServiceWorker } from "./lib/push";
import { MenuButton } from "./components/MenuButton";
import { Login } from "./screens/Login";
import { Home } from "./screens/Home";
import { Calendar } from "./screens/Calendar";
import { Everything } from "./screens/Everything";
import { Tasks } from "./screens/Tasks";
import { Rules } from "./screens/Rules";
import { Knows } from "./screens/Knows";
import { Messages } from "./screens/Messages";
import { Log } from "./screens/Log";
import { Settings } from "./screens/Settings";
import { FirstRun } from "./screens/FirstRun";
import { Memory } from "./screens/Memory";

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

function Frame({ me }: { me: Me }) {
  const loc = useLocation();
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
  if (settings && !settings.settings.first_run_complete && loc.pathname !== "/setup" && me.profile === "real") return <Navigate to="/setup" replace />;
  const bare = loc.pathname === "/";
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      {!bare ? (
        <div className="screenbar">
          <div className="screenbar-inner">
            <Link className="linklike screenbar-back" to="/">
              Back
            </Link>
            <MenuButton />
          </div>
        </div>
      ) : null}
      <main className="main" id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/everything" element={<Everything />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/knows" element={<Knows />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/log" element={<Log />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<FirstRun />} />
          <Route path="/today" element={<Navigate to="/" replace />} />
          <Route path="/talk" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
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
