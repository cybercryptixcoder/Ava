import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { Button } from "../components/ui";
import { SourcesSection } from "./SettingsSources";
import { VoiceSection } from "./SettingsVoice";
import { LocationSwitch } from "../App";

const STEPS = [
  { title: "Connect your calendar and course feeds", body: "So Ava knows when you're busy, in class, or free. Google Calendar and any .ics course calendars." },
  { title: "Set your two places", body: "State College and Bangalore by default. Tap where you are now; every schedule follows. You can rename them in Settings." },
  { title: "Choose Ava's voice", body: "Hear the same lines in a few voices and pick one for replies and one for live mode. Ideally the same voice, so she sounds like one person." },
  { title: "Import your chat history", body: "Optional. Your ChatGPT or Claude export becomes a review queue of projects, goals and commitments, weighted toward what's recent." },
  { title: "Tell Ava what's going on", body: "Talk about everything on your plate, as long as you like. She builds her first picture of your life with you confirming each piece." },
];

export function FirstRun() {
  const [step, setStep] = useState(0);
  const nav = useNavigate();
  const finish = async () => {
    await api.post("/api/setup/complete");
    refetchAll();
    nav("/talk");
  };
  return (
    <div className="screen firstrun">
      <header className="screen-head">
        <h1 className="screen-title">Set up Ava</h1>
        <p className="screen-sub">Five steps. Skip any of them; everything is in Settings later.</p>
      </header>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={i} className="step-mark" data-state={i < step ? "done" : i === step ? "current" : "next"} aria-current={i === step ? "step" : undefined}>
            <span className="num">{i + 1}</span>
            <span className="step-name">{s.title}</span>
          </li>
        ))}
      </ol>
      <section className="band step-body">
        <h2 className="section-title">{STEPS[step].title}</h2>
        <p className="voice-sm">{STEPS[step].body}</p>
        {step === 0 ? <SourcesSection only={["gcal", "ics"]} /> : null}
        {step === 1 ? <LocationSwitch /> : null}
        {step === 2 ? <VoiceSection /> : null}
        {step === 3 ? <SourcesSection only={["chat_import"]} /> : null}
        {step === 4 ? <p className="band-note">Finishing takes you to Talk. Dictate freely; changes Ava picks up appear as chips you accept or reject.</p> : null}
      </section>
      <div className="row-actions">
        {step > 0 ? <Button onClick={() => setStep(step - 1)}>Back</Button> : null}
        {step < STEPS.length - 1 ? (
          <Button kind="primary" onClick={() => setStep(step + 1)}>
            Next step
          </Button>
        ) : (
          <Button kind="primary" onClick={() => void finish()}>
            Start talking
          </Button>
        )}
        <Button kind="quiet" onClick={() => void finish()}>
          Skip setup
        </Button>
      </div>
    </div>
  );
}
