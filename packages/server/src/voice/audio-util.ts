/** Wrap 16-bit mono PCM in a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Extract PCM samples from a 16-bit mono WAV (for the voice benchmark). */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.subarray(0, 4).toString() !== "RIFF") throw new Error("Not a WAV file");
  let off = 12;
  let sampleRate = 16000;
  while (off < wav.length - 8) {
    const id = wav.subarray(off, off + 4).toString();
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") sampleRate = wav.readUInt32LE(off + 12);
    if (id === "data") return { pcm: wav.subarray(off + 8, off + 8 + size), sampleRate };
    off += 8 + size;
  }
  throw new Error("WAV has no data chunk");
}
