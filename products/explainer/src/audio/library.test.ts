import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeWav, encodeWav } from "@titan-design/speech-tts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../workflow/artifacts.js";
import { importAudio, ImportRefused, libraryPaths, readLedger, type ImportRequest } from "./library.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "audio-library-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 1 kHz sine at 44.1 kHz, so the import has to resample it. */
function tone(name: string, seconds = 2, hz = 1000): string {
  const rate = 44_100;
  const samples = Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const file = path.join(dir, name);
  writeFileSync(file, encodeWav({ samples, sampleRate: rate }));
  return file;
}

const request = (file: string, overrides: Partial<ImportRequest> = {}): ImportRequest => ({
  file, id: "test-tone", kind: "sfx", source: { kind: "library", name: "synthetic" }, licence: "CC0-1.0", tags: ["beep"], ...overrides,
});
const library = () => path.join(dir, "lib");
const ledgerLines = () => readFileSync(libraryPaths(library()).ledger, "utf8").trim().split("\n");

describe("importAudio", () => {
  it("records a 2 s tone's sha, duration and loudness and writes a 48 kHz WAV", async () => {
    const file = tone("tone.wav");

    const { entry, added } = await importAudio(library(), request(file));

    expect(added).toBe(true);
    expect(entry.sha256).toBe(sha256(readFileSync(file)));
    expect(entry.durationS).toBeCloseTo(2, 2);
    expect(Number.isFinite(entry.loudness.integratedLufs)).toBe(true);
    const wav = readFileSync(libraryPaths(library()).wav(entry.sha256));
    expect(decodeWav(wav).sampleRate).toBe(48_000);
    expect(entry.wavSha256).toBe(sha256(wav));
    expect(readLedger(library())).toEqual([entry]);
  });

  it("adds no ledger line when the same file is imported again", async () => {
    const file = tone("tone.wav");
    await importAudio(library(), request(file));

    const again = await importAudio(library(), request(file, { id: "another-name" }));

    expect(again.added).toBe(false);
    expect(again.entry.id).toBe("test-tone");
    expect(ledgerLines()).toHaveLength(1);
  });

  it("refuses a non-commercial licence, naming it", async () => {
    const attempt = importAudio(library(), request(tone("nc.wav"), { licence: "CC-BY-NC-4.0", attribution: "Someone" }));

    await expect(attempt).rejects.toThrow(ImportRefused);
    await expect(attempt).rejects.toThrow(/CC-BY-NC-4\.0/);
    expect(readLedger(library())).toEqual([]);
  });

  it("refuses a CC BY file with no attribution", async () => {
    const attempt = importAudio(library(), request(tone("by.wav"), { licence: "CC-BY-4.0" }));

    await expect(attempt).rejects.toThrow(/requires an attribution/);
  });

  it("accepts a CC BY file with its credit line and records it", async () => {
    const { entry } = await importAudio(library(), request(tone("by.wav"), { licence: "CC-BY-4.0", attribution: "Tone by A. Synth (CC BY 4.0)" }));

    expect(entry.attribution).toBe("Tone by A. Synth (CC BY 4.0)");
  });

  it("refuses a second file under an id the ledger already holds", async () => {
    await importAudio(library(), request(tone("a.wav")));

    await expect(importAudio(library(), request(tone("b.wav", 1, 500)))).rejects.toThrow(/already names a different file/);
  });

  it("refuses a silent file", async () => {
    const file = path.join(dir, "silence.wav");
    writeFileSync(file, encodeWav({ samples: new Float32Array(48_000), sampleRate: 48_000 }));

    await expect(importAudio(library(), request(file))).rejects.toThrow(/silent/);
  });
});
