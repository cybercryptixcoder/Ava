import type { KnowsView } from "@ava/shared";
import { useApi } from "../lib/store";
import { Empty, ErrorLine } from "../components/ui";
import { BeliefRow } from "../modules/modules";

const AREA_LABEL: Record<string, string> = {
  study: "Study",
  work: "Work",
  projects: "Projects",
  health: "Health",
  people: "People",
  routines: "Routines",
  interests: "Interests",
  goals: "Goals",
  preferences: "Preferences",
  logistics: "Logistics",
};

export function Knows() {
  const { data, error } = useApi<KnowsView>("/api/knows");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const areas = data.areas.filter((a) => data.beliefs.some((b) => b.area === a));
  return (
    <div className="screen knows">
      <header className="screen-head">
        <h1 className="screen-title">What Ava knows about you</h1>
      </header>
      <div className="knows-key" aria-label="How to read this">
        <span className="prov-key" data-prov="stated">
          Stated by you
        </span>
        <span className="prov-key" data-prov="observed">
          Observed from data
        </span>
        <span className="prov-key" data-prov="inferred">
          Inferred by Ava
        </span>
        <span className="knows-key-note">Confidence fades unless a belief is confirmed again.</span>
      </div>
      {data.proposed.length ? (
        <section className="band" aria-label="Unconfirmed">
          <h2 className="section-title">Ava thinks, but hasn't checked</h2>
          <p className="band-note">Inferences stay proposals until you confirm them.</p>
          <ul className="beliefs">
            {data.proposed.map((b) => (
              <BeliefRow key={b.id} belief={b} />
            ))}
          </ul>
        </section>
      ) : null}
      {!data.beliefs.length && !data.proposed.length ? <Empty title="Ava doesn't know much yet.">Talk to her about what's going on; what she learns shows up here for you to confirm or correct.</Empty> : null}
      <div className="knows-areas">
        {areas.map((a) => (
          <section key={a} className="band" aria-label={AREA_LABEL[a] ?? a}>
            <h2 className="section-title">{AREA_LABEL[a] ?? a}</h2>
            <ul className="beliefs">
              {data.beliefs
                .filter((b) => b.area === a)
                .map((b) => (
                  <BeliefRow key={b.id} belief={b} />
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
