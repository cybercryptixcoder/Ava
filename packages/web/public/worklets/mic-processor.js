/*
 * Microphone capture for live mode. Downsamples to 16 kHz, converts to
 * 16-bit PCM, and posts 20 ms frames plus a level reading (for the
 * escapement and for barge-in detection).
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.frame = new Int16Array(320);
    this.n = 0;
    this.levelSum = 0;
    this.levelN = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.levelSum += s * s;
      this.levelN++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, s));
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frame.length) {
          const rms = Math.sqrt(this.levelSum / Math.max(1, this.levelN));
          this.port.postMessage({ pcm: this.frame.buffer.slice(0), level: rms });
          this.n = 0;
          this.levelSum = 0;
          this.levelN = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
