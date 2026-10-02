import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { placeTime } from "../lib/time";

interface SettingsResp {
  settings: { locations: { id: string; label: string; tz: string }[]; current_location_id: string; first_run_complete: boolean };
  location: { id: string; label: string; tz: string };
}

/** Both places with their current times; one tap moves every schedule. */
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
