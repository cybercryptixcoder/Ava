import fs from "node:fs";
import { buildApp } from "../app";
import { wavToPcm } from "../voice/audio-util";
import { LIVE_IN_RATE, LIVE_OUT_RATE } from "../voice/live";
import { TurnDetector } from "../voice/turn-detector";
import { planSpeech } from "../voice/speech-adapt";
import { takeSentences, parseScript } from "@ava/shared";
import { js, newId } from "../db/db";

/**
 * Live-mode voice pipeline benchmark. Measures every stage:
 *   eot_detect   end of speech in the audio -> end-of-turn decided
 *   llm_ttft     request -> first token, per live model
 *   first_sentence  request -> first complete sentence
 *   tts_ttfa     first sentence sent -> first audio byte
 *   total        eot_detect + first_sentence + tts_ttfa (+ connect when cold)
 *
 * Usage: npm run bench:voice [-- --runs 3] [-- --wav my-turn.wav]
 * Without --wav, the input utterance is synthesized with your live TTS voice.
 */
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

const UTTERANCE = "Okay so I've got the CMPSC 465 quiz on Thursday and I haven't really started, and I also told Riya I'd send her the slides. What should I do first?";

async function inputAudio(app: ReturnType<typeof buildApp>): Promise<Buffer> {
  const wav = arg("--wav");
  if (wav) {
    const { pcm, sampleRate } = wavToPcm(fs.readFileSync(wav));
    if (sampleRate !== LIVE_IN_RATE) throw new Error(`Use a 16 kHz mono WAV (got ${sampleRate} Hz)`);
    return pcm;
  }
  const { voice } = app.svc;
  const c = voice.choice("live");
  if (c.provider === "elevenlabs") {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${c.voice_id}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": app.svc.cfg.elevenlabs.key!, "content-type": "application/json" },
      body: JSON.stringify({ text: UTTERANCE, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) throw new Error(`Couldn't synthesize the test utterance: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { authorization: `Bearer ${app.svc.cfg.cartesia.key}`, "cartesia-version": "2026-08-14", "content-type": "application/json" },
    body: JSON.stringify({ model_id: c.model, transcript: UTTERANCE, voice: c.voice_id, output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 } }),
  });
  if (!res.ok) throw new Error(`Couldn't synthesize the test utterance: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sttStage(app: ReturnType<typeof buildApp>, pcm: Buffer): Promise<{ text: string; eot_detect_ms: number }> {
  const stt = app.svc.voice.sttAdapter();
  if (!stt) throw new Error("No speech-to-text key");
  const v = app.svc.settings.get().voice;
  const speechEndAudioS = pcm.length / 2 / LIVE_IN_RATE;
  const withSilence = Buffer.concat([pcm, Buffer.alloc(LIVE_IN_RATE * 2 * 8)]);
  return new Promise((resolve, reject) => {
    let speechEndWallMs = 0;
    const det = new TurnDetector(v.turn_patience, (s) => {
      if (s.type === "end") {
        stream.then((st) => st.close());
        resolve({ text: s.text, eot_detect_ms: Date.now() - speechEndWallMs });
      }
    });
    const stream = stt.connect({ sampleRate: LIVE_IN_RATE, keyterms: v.vocabulary, patience: v.turn_patience }, (e) => {
      if (e.type === "error") reject(new Error(e.message));
      else det.handle(e);
    });
    void stream.then(async (st) => {
      const chunk = LIVE_IN_RATE * 2 * 0.02;
      const start = Date.now();
      for (let off = 0, i = 0; off < withSilence.length; off += chunk, i++) {
        st.send(withSilence.subarray(off, off + chunk));
        if (!speechEndWallMs && off / 2 / LIVE_IN_RATE >= speechEndAudioS) speechEndWallMs = Date.now();
        const due = start + (i + 1) * 20;
        await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
      }
    }, reject);
    setTimeout(() => reject(new Error("No end of turn within the audio")), 30_000);
  });
}

async function llmStage(app: ReturnType<typeof buildApp>, model: string, text: string): Promise<{ ttft: number; first_sentence: number; sentence: string }> {
  const { conversation, canvas, models } = app.svc;
  const conv = canvas.current();
  let first = -1;
  let firstSentence = -1;
  let sentence = "";
  let buf = "";
  const start = Date.now();
  const ac = new AbortController();
  await models
    .stream(
      {
        purpose: "bench.live",
        origin: "interactive",
        model,
        maxTokens: 300,
        lowLatency: true,
        system: conversation.systemBlocks(true),
        messages: [{ role: "user", content: `${conversation.contextBlock(conv, text, true, ["Live mode benchmark."])}\n\n${text}` }],
        cacheMessages: true,
        signal: ac.signal,
      },
      (d) => {
        if (first < 0) first = Date.now() - start;
        buf += d;
        const [s] = takeSentences(buf, 8);
        if (s.length && firstSentence < 0) {
          firstSentence = Date.now() - start;
          sentence = parseScript(s[0]).text;
          ac.abort();
        }
      },
    )
    .catch(() => {});
  return { ttft: first, first_sentence: firstSentence, sentence };
}

async function ttsStage(app: ReturnType<typeof buildApp>, sentence: string): Promise<{ connect: number; ttfa: number }> {
  const { voice } = app.svc;
  const c = voice.choice("live");
  const t0 = Date.now();
  let connected = 0;
  return new Promise((resolve, reject) => {
    let sentAt = 0;
    voice.tts[c.provider]
      .stream(
        { model: c.model, voice_id: c.voice_id, sampleRate: LIVE_OUT_RATE },
        {
          onAudio: () => {
            if (sentAt) {
              const ttfa = Date.now() - sentAt;
              sentAt = 0;
              resolve({ connect: connected, ttfa });
            }
          },
          onWords: () => {},
          onDone: () => {},
          onError: reject,
        },
      )
      .then((s) => {
        connected = Date.now() - t0;
        sentAt = Date.now();
        s.send(planSpeech(sentence).text);
        s.finish();
        setTimeout(() => s.cancel(), 8000);
      }, reject);
  });
}

async function main() {
  const app = buildApp({ config: { profile: process.env.AVA_PROFILE === "test" ? "test" : "real" } });
  const { svc } = app;
  if (!svc.models.available || !svc.voice.sttAdapter() || !svc.voice.ttsAvailable("live")) {
    console.error("The benchmark needs ANTHROPIC_API_KEY, a speech-to-text key, a text-to-speech key and a live voice chosen in Settings.");
    process.exit(1);
  }
  const runs = Number(arg("--runs") ?? 3);
  const pcm = await inputAudio(app);
  const models = [svc.cfg.models.live, svc.cfg.models.liveFast];
  const rows: Record<string, number | string>[] = [];
  for (let r = 0; r < runs; r++) {
    const stt = await sttStage(app, pcm);
    for (const m of models) {
      const llm = await llmStage(app, m, stt.text);
      const tts = await ttsStage(app, llm.sentence || "Here's where I'd start.");
      const total = stt.eot_detect_ms + llm.first_sentence + tts.ttfa;
      const row = { run: r + 1, model: m, eot_detect_ms: stt.eot_detect_ms, llm_ttft_ms: llm.ttft, first_sentence_ms: llm.first_sentence, tts_connect_ms: tts.connect, tts_ttfa_ms: tts.ttfa, total_ms: total };
      rows.push(row);
      svc.db.run("INSERT INTO latency_samples (id, at, mode, model, tts, stt, stages, total_ms) VALUES (?, ?, 'bench', ?, ?, ?, ?, ?)", [
        newId("lat"),
        new Date().toISOString(),
        m,
        `${svc.voice.choice("live").provider}:${svc.voice.choice("live").model}`,
        svc.voice.sttAdapter()!.id,
        js(row),
        total,
      ]);
    }
    console.log(`run ${r + 1}: heard "${stt.text}"`);
  }
  console.table(rows);
  for (const m of models) {
    const t = rows.filter((x) => x.model === m).map((x) => Number(x.total_ms)).sort((a, b) => a - b);
    console.log(`${m}: median end-of-turn to first audio ≈ ${t[Math.floor(t.length / 2)]} ms (target under ~800 ms; excludes browser playback buffering)`);
  }
  app.stop();
  process.exit(0);
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
