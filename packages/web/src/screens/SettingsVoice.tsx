import { useState } from "react";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { playSpeech, stopSpeech } from "../lib/reveal";
import { Button, Empty, ErrorLine, Field, Switch } from "../components/ui";

interface Providers {
  tts: { id: "elevenlabs" | "cartesia"; label: string; available: boolean; models: { id: string; label: string; role: string; notes: string }[] }[];
  stt: { id: string; label: string; available: boolean }[];
  choice: { async: Choice; live: Choice };
  live_models: string[];
}
interface Choice {
  provider: "elevenlabs" | "cartesia";
  model: string;
  voice_id: string;
}
interface Voice {
  id: string;
  name: string;
  description: string;
}
interface VoiceSettings {
  autoplay: boolean;
  stt_provider: "deepgram" | "assemblyai";
  turn_patience: number;
  vocabulary: string[];
  live_model: string;
  pronunciations: { text: string; say: string }[];
}

function Candidate({ c, voices, onChange, onRemove }: { c: Choice; voices: Voice[]; onChange: (c: Choice) => void; onRemove: () => void }) {
  return (
    <div className="cand-pick">
      <select aria-label="Voice" value={c.voice_id} onChange={(e) => onChange({ ...c, voice_id: e.target.value })}>
        <option value="">Choose a voice</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <Button size="sm" kind="quiet" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

export function VoiceSection() {
  const { data: p, error } = useApi<Providers>("/api/voice/providers");
  const { data: s } = useApi<{ settings: { voice: VoiceSettings } }>("/api/settings");
  const { data: lines } = useApi<{ key: string; label: string; text: string }[]>("/api/voice/audition/lines");
  const [provider, setProvider] = useState<"elevenlabs" | "cartesia">("elevenlabs");
  const { data: voices, error: vErr } = useApi<Voice[]>(p?.tts.find((t) => t.id === provider)?.available ? `/api/voice/voices?provider=${provider}` : null);
  const [cands, setCands] = useState<Choice[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [timings, setTimings] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [vocab, setVocab] = useState<string | null>(null);
  const [lex, setLex] = useState<string | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!p || !s) return <div aria-busy="true" />;
  const v = s.settings.voice;
  const save = async (patch: Partial<VoiceSettings> & Record<string, unknown>) => {
    setErr(null);
    try {
      await api.patch("/api/settings", { voice: patch });
      refetchAll();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const ttsAny = p.tts.some((t) => t.available);
  const prov = p.tts.find((t) => t.id === provider)!;
  const expressive = prov.models.find((m) => m.role !== "low_latency")!;
  const fast = prov.models.find((m) => m.role !== "expressive") ?? expressive;
  const play = async (c: Choice, model: string, line: string) => {
    const key = `${c.provider}:${model}:${c.voice_id}:${line}`;
    setErr(null);
    setPlaying(key);
    try {
      const r = await api.post<{ audio_id: string; ms: number }>("/api/voice/audition", { provider: c.provider, model, voice_id: c.voice_id, line });
      if (r.ms) setTimings((t) => ({ ...t, [key]: r.ms }));
      playSpeech(r.audio_id, [], { onEnd: () => setPlaying(null) });
    } catch (e) {
      setErr((e as Error).message);
      setPlaying(null);
    }
  };
  const describe = (c: Choice) => voices?.find((x) => x.id === c.voice_id)?.name ?? (c.voice_id || "not chosen");
  return (
    <div className="voice-settings">
      <ErrorLine error={err} />
      <div className="kv">
        <div className="kv-row">
          <span>Speak replies automatically</span>
          <Switch checked={v.autoplay} label="Speak replies automatically" onChange={(x) => void save({ autoplay: x })} />
        </div>
        <div className="kv-row">
          <span>Async replies and the brief</span>
          <span className="kv-val">
            {p.choice.async.provider} {p.choice.async.model}, voice {p.choice.async.voice_id ? <code>{p.choice.async.voice_id.slice(0, 10)}</code> : "not chosen"}
          </span>
        </div>
        <div className="kv-row">
          <span>Live mode</span>
          <span className="kv-val">
            {p.choice.live.provider} {p.choice.live.model}, voice {p.choice.live.voice_id ? <code>{p.choice.live.voice_id.slice(0, 10)}</code> : "not chosen"}
          </span>
        </div>
        <div className="kv-row">
          <span>Live mode model</span>
          <select aria-label="Live mode model" value={v.live_model} onChange={(e) => void save({ live_model: e.target.value })}>
            {p.live_models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="kv-row">
          <span>Speech recognition</span>
          <select aria-label="Speech recognition provider" value={v.stt_provider} onChange={(e) => void save({ stt_provider: e.target.value as "deepgram" })}>
            {p.stt.map((x) => (
              <option key={x.id} value={x.id} disabled={!x.available}>
                {x.label}
                {x.available ? "" : " (no key)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Field label={`Patience before Ava answers in live mode: ${Math.round(v.turn_patience * 100)}%`} hint="Higher waits longer through pauses and unfinished sentences. You think out loud, so the default leans patient.">
        {(id) => <input id={id} type="range" min={0} max={1} step={0.05} defaultValue={v.turn_patience} onChange={(e) => void save({ turn_patience: Number(e.target.value) })} />}
      </Field>

      <Field label="Words to recognize" hint="Course codes, project names, people. One per line; up to 100.">
        {(id) => (
          <>
            <textarea id={id} rows={5} value={vocab ?? v.vocabulary.join("\n")} onChange={(e) => setVocab(e.target.value)} />
            {vocab !== null ? (
              <Button size="sm" onClick={() => void save({ vocabulary: vocab.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 100) }).then(() => setVocab(null))}>
                Save words
              </Button>
            ) : null}
          </>
        )}
      </Field>

      <Field label="Pronunciations" hint='One per line as "written = spoken", for example "CMPSC = comp sci".'>
        {(id) => (
          <>
            <textarea id={id} rows={4} value={lex ?? v.pronunciations.map((x) => `${x.text} = ${x.say}`).join("\n")} onChange={(e) => setLex(e.target.value)} />
            {lex !== null ? (
              <Button
                size="sm"
                onClick={() =>
                  void save({
                    pronunciations: lex
                      .split("\n")
                      .map((l) => l.split("="))
                      .filter((x) => x.length === 2 && x[0].trim() && x[1].trim())
                      .map(([a, b]) => ({ text: a.trim(), say: b.trim() })),
                  }).then(() => setLex(null))
                }
              >
                Save pronunciations
              </Button>
            ) : null}
          </>
        )}
      </Field>

      <section className="audition" aria-label="Voice audition">
        <h3 className="section-title">Voice audition</h3>
        {!ttsAny ? (
          <Empty title="No text-to-speech provider is set up.">Add ELEVENLABS_API_KEY or CARTESIA_API_KEY to your environment and restart. Then voices appear here to compare.</Empty>
        ) : (
          <>
            <p className="band-note">Pick up to four voices and hear the same lines side by side. Each plays in the expressive model and the fast model, so you can check Ava sounds like one person in both modes.</p>
            <div className="row-actions">
              {p.tts.map((t) => (
                <Button key={t.id} size="sm" kind={provider === t.id ? "primary" : "default"} disabled={!t.available} onClick={() => setProvider(t.id)}>
                  {t.label}
                  {t.available ? "" : " (no key)"}
                </Button>
              ))}
              <Button size="sm" disabled={cands.length >= 4 || !voices?.length} onClick={() => setCands([...cands, { provider, model: expressive.id, voice_id: "" }])}>
                Add a voice to compare
              </Button>
            </div>
            <ErrorLine error={vErr} />
            {cands.length ? (
              <div className="audition-grid" style={{ ["--cols" as string]: cands.length }}>
                <div className="aud-corner" />
                {cands.map((c, i) => (
                  <div key={i} className="aud-col-head">
                    <Candidate c={c} voices={voices ?? []} onChange={(n) => setCands(cands.map((x, j) => (j === i ? n : x)))} onRemove={() => setCands(cands.filter((_, j) => j !== i))} />
                    <p className="aud-models">
                      {c.provider === "elevenlabs" ? `${expressive.label} and ${fast.label}` : prov.models[0].label}
                    </p>
                  </div>
                ))}
                {(lines ?? []).map((l) => (
                  <div key={l.key} className="aud-row" style={{ display: "contents" }}>
                    <div className="aud-line">
                      <span className="label">{l.label}</span>
                      <p className="voice-sm">{l.text.replace(/\[\[[^\]]+\]\]/g, "")}</p>
                    </div>
                    {cands.map((c, i) => (
                      <div key={i} className="aud-cell">
                        {[expressive, fast].filter((m, k, arr) => arr.findIndex((x) => x.id === m.id) === k).map((m) => {
                          const key = `${c.provider}:${m.id}:${c.voice_id}:${l.key}`;
                          return (
                            <Button key={m.id} size="sm" kind="quiet" disabled={!c.voice_id} busy={playing === key} onClick={() => (playing ? stopSpeech() : void play(c, m.id, l.key))}>
                              {m.role === "low_latency" ? "Fast" : "Expressive"}
                              {timings[key] ? <span className="num aud-ms"> {timings[key]} ms</span> : null}
                            </Button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
                <div className="aud-line" />
                {cands.map((c, i) => (
                  <div key={i} className="aud-cell aud-choose">
                    <Button size="sm" disabled={!c.voice_id} onClick={() => void save({ async_voice: { provider: c.provider, model: expressive.id, voice_id: c.voice_id } })}>
                      Use for replies
                    </Button>
                    <Button size="sm" disabled={!c.voice_id} onClick={() => void save({ live_voice: { provider: c.provider, model: fast.id, voice_id: c.voice_id } })}>
                      Use for live mode
                    </Button>
                    <Button
                      size="sm"
                      kind="primary"
                      disabled={!c.voice_id}
                      onClick={() => void save({ async_voice: { provider: c.provider, model: expressive.id, voice_id: c.voice_id }, live_voice: { provider: c.provider, model: fast.id, voice_id: c.voice_id } })}
                    >
                      Use {describe(c)} for both
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
