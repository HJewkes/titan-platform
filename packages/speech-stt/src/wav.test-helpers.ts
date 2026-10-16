import { readFileSync } from "node:fs";
import type { Audio } from "./schemas.js";

/** Reads a canonical PCM16 mono RIFF; enough for a smoke check, not a general WAV reader. */
export function readPcm16Mono(path: string): Audio {
  const wav = readFileSync(path);
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = wav.readUInt32LE(offset + 12);
    if (id === "data") {
      const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + size));
      return { samples: Float32Array.from(pcm, (v) => v / 32768), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}
