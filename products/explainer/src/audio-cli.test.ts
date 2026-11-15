import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeWav } from "@titan-design/speech-tts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudioCli } from "./audio-cli.js";
import { readLedger } from "./audio/library.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "audio-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runAudioCli(["audio", ...argv], { out: (t) => (out += t), err: (t) => (err += t), env, now: () => new Date("2026-11-15T00:00:00Z") });
  return { code, out, err };
}

const lib = (name = "lib") => path.join(dir, name);

function tone(): string {
  const file = path.join(dir, "tone.wav");
  writeFileSync(file, encodeWav({ samples: Float32Array.from({ length: 24_000 }, (_, i) => 0.4 * Math.sin(i / 7)), sampleRate: 24_000 }));
  return file;
}

const importArgs = (licence: string) => [
  "import", tone(), "--id", "tone", "--kind", "sfx", "--licence", licence, "--source-kind", "download", "--source-name", "synthetic", "--tags", "beep,test",
];

describe("explainer audio", () => {
  it("imports, generates and lists, exiting 0 and printing each ledger id", async () => {
    const env = { EXPLAINER_AUDIO_LIBRARY: lib("env") };

    const imported = await cli(importArgs("CC0-1.0"), env);
    const generated = await cli(["gen", "--kind", "bgm", "--seed", "7", "--duration-s", "2"], env);
    const listed = await cli(["list"], env);

    expect([imported.code, generated.code, listed.code]).toEqual([0, 0, 0]);
    expect(generated.out).toMatch(/^added pad-s7 [0-9a-f]{64}\n$/);
    expect(listed.out.split("\n").filter(Boolean).map((line) => line.split("\t")[0])).toEqual(["tone", "pad-s7"]);
    expect(listed.out).toMatch(/^tone\tsfx\tCC0-1\.0\t1\.00\t-?\d+\.\d\tbeep,test\n/);
  });

  it("imports a generated SFX as generated-own with its anchor and generator", async () => {
    const result = await cli(["gen", "--kind", "sfx", "--name", "chime", "--seed", "1", "--audio-library", lib()]);

    expect(result.code).toBe(0);
    const [entry] = readLedger(lib());
    expect(entry).toMatchObject({ id: "chime-s1", kind: "sfx", licence: "generated-own", anchorS: 0.003, source: { kind: "generator", name: "explainer-procedural" } });
    expect(entry!.generator).toMatchObject({ seed: 1, params: { name: "chime" } });
  });

  it("is a usage error to ask for an SFX with no name", async () => {
    const result = await cli(["gen", "--kind", "sfx", "--seed", "1", "--audio-library", lib()]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("--name");
  });

  it("exits 1 and names the licence when an import is refused", async () => {
    const result = await cli([...importArgs("CC-BY-4.0"), "--audio-library", lib()]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('refused: licence "CC-BY-4.0" is not allowed');
  });
});
