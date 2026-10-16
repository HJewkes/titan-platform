import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "./wav.js";

function floatStereoWav(left: number[], right: number[], sampleRate: number, dataSize?: number): Uint8Array {
  const bytes = new Uint8Array(44 + left.length * 8);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint16(34, 32, true);
  tag(36, "data");
  view.setUint32(40, dataSize ?? left.length * 8, true);
  left.forEach((l, i) => {
    view.setFloat32(44 + i * 8, l, true);
    view.setFloat32(48 + i * 8, right[i] ?? 0, true);
  });
  return bytes;
}

describe("WAV codec", () => {
  // Mutation caught: the encoder writes a fixed 24 kHz rate.
  it("round-trips PCM16 audio and its sample rate within one quantisation step", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);

    const decoded = decodeWav(encodeWav({ samples, sampleRate: 16_000 }));

    expect(decoded.sampleRate).toBe(16_000);
    [...decoded.samples].forEach((s, i) => expect(s).toBeCloseTo(samples[i] ?? 0, 3));
  });

  // Mutation caught: only the left channel is kept.
  it("downmixes float32 stereo to mono", () => {
    const decoded = decodeWav(floatStereoWav([1, 0.5], [0, 0.5], 48_000));

    expect([...decoded.samples]).toEqual([0.5, 0.5]);
  });

  // Mutation caught: a streamed header's 0xFFFFFFFF data size is trusted, reading past the buffer.
  it("reads to the end when a streamed WAV leaves its data size unpatched", () => {
    const decoded = decodeWav(floatStereoWav([0.25, 0.25, 0.25], [0.25, 0.25, 0.25], 24_000, 0xffffffff));

    expect(decoded.samples).toHaveLength(3);
  });

  it("rejects a buffer that is not RIFF/WAVE", () => {
    expect(() => decodeWav(new TextEncoder().encode("not a wav at all"))).toThrow(/RIFF/);
  });
});
