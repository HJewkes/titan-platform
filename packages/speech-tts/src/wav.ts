import type { Audio } from "./types.js";

const PCM = 1;
const IEEE_FLOAT = 3;
const EXTENSIBLE = 0xfffe;

interface Format {
  encoding: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

const ascii = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function readFormat(view: DataView, at: number): Format {
  const tag = view.getUint16(at, true);
  return {
    // WAVE_FORMAT_EXTENSIBLE keeps the real format tag in the first two bytes of its sub-format GUID.
    encoding: tag === EXTENSIBLE ? view.getUint16(at + 24, true) : tag,
    channels: view.getUint16(at + 2, true),
    sampleRate: view.getUint32(at + 4, true),
    bitsPerSample: view.getUint16(at + 14, true),
  };
}

function sampleReader(format: Format): (view: DataView, at: number) => number {
  if (format.encoding === PCM && format.bitsPerSample === 16) return (v, at) => v.getInt16(at, true) / 0x8000;
  if (format.encoding === IEEE_FLOAT && format.bitsPerSample === 32) return (v, at) => v.getFloat32(at, true);
  throw new Error(`unsupported WAV encoding ${format.encoding} at ${format.bitsPerSample} bits; send PCM16 or float32`);
}

/** Downmixes to mono by averaging channels. */
function readSamples(view: DataView, at: number, size: number, format: Format): Float32Array {
  const read = sampleReader(format);
  const bytesPerSample = format.bitsPerSample / 8;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(size / frameBytes);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let ch = 0; ch < format.channels; ch++) sum += read(view, at + frame * frameBytes + ch * bytesPerSample);
    samples[frame] = sum / format.channels;
  }
  return samples;
}

/** Parses a RIFF/WAVE buffer, taking the sample rate from its header. */
export function decodeWav(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") throw new Error("not a RIFF/WAVE buffer");
  let format: Format | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = ascii(view, at);
    // A WAV streamed to a pipe cannot seek back to patch its sizes, so a data size past the end means "to the end".
    const size = Math.min(view.getUint32(at + 4, true), bytes.byteLength - at - 8);
    if (id === "fmt ") format = readFormat(view, at + 8);
    if (id === "data") {
      if (!format) throw new Error("WAV data chunk comes before its fmt chunk");
      return { samples: readSamples(view, at + 8, size, format), sampleRate: format.sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Mono PCM16, clipping samples outside [-1, 1]. */
export function encodeWav(audio: Audio): Uint8Array {
  const dataBytes = audio.samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  audio.samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true));
  return bytes;
}

export const durationOf = (audio: Audio): number => audio.samples.length / audio.sampleRate;
