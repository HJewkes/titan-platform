import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Audio } from "@titan-design/speech-tts";
import type { SmokeEngines } from "./smoke-engines.ts";
import { smokeReportSchema, type SmokeReport } from "./smoke-report.ts";
import { runSmoke, type SmokeDeps } from "./smoke-run.ts";

const SAMPLE_RATE = 16_000;
const AUDIO_SECONDS = 6;

// A synthetic 220 Hz tone stands in for speech; nothing here is recorded audio.
function tone(seconds: number): Audio {
  const samples = Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  return { samples, sampleRate: SAMPLE_RATE };
}

/** Each call advances the fake clock by the next cost: the first is the cold call, the second the warm one. */
function clocked<T>(clock: { ms: number }, costsMs: readonly [number, number], result: () => T): () => Promise<T> {
  let calls = 0;
  return async () => {
    clock.ms += costsMs[Math.min(calls++, 1)] ?? 0;
    return result();
  };
}

interface FakeCosts {
  tts?: [number, number];
  stt?: [number, number];
  phones?: [number, number];
}

const model = (name: string) => ({ model: `fake/${name}`, revision: "fake-rev", dtype: "fp32" });
const noop = async (): Promise<void> => {};

function fakeEngines(clock: { ms: number }, costs: FakeCosts = {}): SmokeEngines {
  return {
    tts: () => ({ ...model("tts"), synthesize: clocked(clock, costs.tts ?? [5000, 2000], () => tone(AUDIO_SECONDS)) }),
    stt: () => ({ ...model("stt"), dispose: noop, transcribe: clocked(clock, costs.stt ?? [1500, 500], () => "the quick lamp") }),
    phones: () => ({ ...model("phones"), dispose: noop, recognize: clocked(clock, costs.phones ?? [4000, 3000], () => ({ phones: "ð ə", frames: 299 })) }),
  };
}

describe("smoke:speech on fake engines", () => {
  let dir = "";
  let logs: string[] = [];
  let out = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "smoke-speech-"));
    out = path.join(dir, "report.json");
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(engines: (clock: { ms: number }) => SmokeEngines = fakeEngines, env: Record<string, string> = {}): SmokeDeps {
    const clock = { ms: 0 };
    return { engines: engines(clock), env: { TITAN_SPEECH_CACHE: path.join(dir, "cache"), ...env }, now: () => clock.ms, log: (l) => logs.push(l) };
  }

  const smoke = (argv: string[], d: SmokeDeps = deps()) => runSmoke([...argv, "--out", out, "--wav", path.join(dir, "smoke.wav")], d);
  const report = (): SmokeReport => smokeReportSchema.parse(JSON.parse(readFileSync(out, "utf8")));

  it("writes a report for the whole suite that matches the zod schema", async () => {
    const code = await smoke(["--suite", "--device", "cpu"]);

    expect(code).toBe(0);
    const json: unknown = JSON.parse(readFileSync(out, "utf8"));
    expect(smokeReportSchema.safeParse(json).error).toBeUndefined();
    expect(report()).toMatchObject({ ok: true, suite: ["tts", "stt", "phones"], profile: null, cache: { source: "env" } });
    expect(Object.values(report().stages).map((s) => s.device)).toEqual(["cpu", "cpu", "cpu"]);
  });

  it("reports RTF as audio seconds over the warm call's wall seconds", async () => {
    await smoke(["--suite", "all"]);

    const { tts, stt, phones } = report().stages;
    expect(tts).toMatchObject({ ok: true, audioS: 6, inferS: 2, loadS: 3, rtf: 3 });
    expect(stt).toMatchObject({ ok: true, audioS: 6, inferS: 0.5, rtf: 12 });
    expect(phones).toMatchObject({ ok: true, audioS: 6, inferS: 3, rtf: 2 });
  });

  it("feeds stt and phones the WAV the tts stage wrote", async () => {
    await smoke(["--suite", "tts,stt"]);

    const wav = path.join(dir, "smoke.wav");
    expect(existsSync(wav)).toBe(true);
    expect(report().stages.tts).toMatchObject({ wavPath: wav });
    expect(report().stages.stt).toMatchObject({ words: 3, transcript: "the quick lamp", wer: 0.833 });
  });

  it("turns a zero-second warm call into a failed stage instead of an infinite RTF", async () => {
    const code = await smoke(["--suite", "tts,stt"], deps((clock) => fakeEngines(clock, { stt: [100, 0] })));

    expect(code).toBe(1);
    expect(report().stages.stt).toMatchObject({ ok: false, model: "fake/stt", error: expect.stringContaining("cached?") });
  });

  it("stops after a failed tts stage and names its model", async () => {
    const failing = (clock: { ms: number }): SmokeEngines => ({
      ...fakeEngines(clock),
      tts: () => ({ ...model("tts"), synthesize: () => Promise.reject(new Error("model load failed")) }),
    });

    const code = await smoke(["--suite"], deps(failing));

    expect(code).toBe(1);
    expect(report().stages).toEqual({ tts: { ok: false, device: "cpu", ...model("tts"), error: expect.stringContaining("model load failed") } });
  });

  it("refuses a device detectSpeechRuntime does not know, before any stage runs", async () => {
    const code = await smoke(["--device", "tpu"]);

    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("TITAN_SPEECH_DEVICE_TTS=tpu: unknown device");
    expect(existsSync(out)).toBe(false);
  });

  it("lets --device beat a per-component device variable", async () => {
    const code = await smoke(["--device", "cpu"], deps(fakeEngines, { TITAN_SPEECH_DEVICE_STT: "tpu" }));

    expect(code).toBe(0);
  });

  it("reads the runtime section of the --profile file", async () => {
    const profile = path.join(dir, "profile.json");
    const cacheDir = path.join(dir, "profile-cache");
    writeFileSync(profile, JSON.stringify({ version: 1, runtime: { cacheDir } }));

    await smoke(["--profile", profile], { ...deps(), env: {} });

    expect(report()).toMatchObject({ profile, cache: { dir: cacheDir, source: "profile", usedBytes: 0 } });
  });

  it("rejects an unknown suite stage with exit 2", async () => {
    expect(await smoke(["--suite", "tts,video"])).toBe(2);
    expect(logs.join("\n")).toContain("unknown suite stage video");
  });
});
