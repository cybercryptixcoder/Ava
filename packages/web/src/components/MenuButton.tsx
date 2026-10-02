import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useApi } from "../lib/store";
import { Sheet } from "./ui";
import { LocationSwitch } from "./LocationSwitch";

/**
 * One way into everything that is not the stack: the front room's other two
 * views, then the back room. Also where the two places live.
 */
export function MenuButton({ label = "Menu" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { data: clock } = useApi<{ simulated: boolean; profile: string }>("/api/dev/clock");
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <>
      <button type="button" className="menu-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Menu">
        <nav className="menu" aria-label="Screens">
          <ul className="menu-list">
            <li>
              <Link className="menu-link" to="/calendar">
                Calendar
              </Link>
              <span className="menu-note">Your day and Ava's check-ins</span>
            </li>
            <li>
              <Link className="menu-link" to="/everything">
                Everything
              </Link>
              <span className="menu-note">Threads, items and subtasks</span>
            </li>
          </ul>
          <ul className="menu-list menu-backroom">
            <li>
              <Link className="menu-link" to="/tasks">
                Tasks and projects
              </Link>
            </li>
            <li>
              <Link className="menu-link" to="/rules">
                Rules
              </Link>
            </li>
            <li>
              <Link className="menu-link" to="/knows">
                What Ava knows
              </Link>
            </li>
            <li>
              <Link className="menu-link" to="/messages">
                Messages
              </Link>
            </li>
            <li>
              <Link className="menu-link" to="/log">
                Log
              </Link>
            </li>
            <li>
              <Link className="menu-link" to="/settings">
                Settings
              </Link>
            </li>
          </ul>
          <div className="menu-foot">
            <LocationSwitch compact />
            {clock?.simulated ? <p className="menu-sim">Test profile, on a simulated clock</p> : clock?.profile === "test" ? <p className="menu-sim">Test profile</p> : null}
          </div>
        </nav>
      </Sheet>
    </>
  );
}
