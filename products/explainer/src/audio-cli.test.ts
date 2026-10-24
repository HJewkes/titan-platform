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
  const code = await runAudioCli(["audio", ...argv], { out: (t) => (out += t), err: (t) => (err += t), env, now: () => new Date("2026-10-23T00:00:00Z") });
  return { code, out, err };
}

const lib = (name = "lib") => path.join(dir, name);
const shaFrom = (out: string) => out.trim().split(" ")[2];

function tone(): string {
  const file = path.join(dir, "tone.wav");
  writeFileSync(file, encodeWav({ samples: Float32Array.from({ length: 24_000 }, (_, i) => 0.4 * Math.sin(i / 7)), sampleRate: 24_000 }));
  return file;
}

describe("explainer audio gen", () => {
  it("makes the same bed sha from seed 7 twice and a different one from seed 8", async () => {
    const first = await cli(["gen", "--kind", "bgm", "--seed", "7", "--duration-s", "4", "--audio-library", lib("a")]);
    const second = await cli(["gen", "--kind", "bgm", "--seed", "7", "--duration-s", "4", "--audio-library", lib("b")]);
    const other = await cli(["gen", "--kind", "bgm", "--seed", "8", "--duration-s", "4", "--audio-library", lib("a")]);

    expect([first.code, second.code, other.code]).toEqual([0, 0, 0]);
    expect(first.out).toMatch(/^added pad-s7 [0-9a-f]{64}\n$/);
    expect(shaFrom(second.out)).toBe(shaFrom(first.out));
    expect(shaFrom(other.out)).not.toBe(shaFrom(first.out));
  });

  it("imports an SFX as generated-own with its anchor and generator", async () => {
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
});

describe("explainer audio import", () => {
  const importArgs = (licence: string) => [
    "import", tone(), "--id", "tone", "--kind", "sfx", "--licence", licence, "--source-kind", "download", "--source-name", "synthetic", "--tags", "beep,test",
  ];

  it("exits 1 and names the licence when it is refused", async () => {
    const result = await cli([...importArgs("CC-BY-NC-4.0"), "--audio-library", lib()]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('refused: licence "CC-BY-NC-4.0" is not allowed');
  });

  it("reads the library from EXPLAINER_AUDIO_LIBRARY and lists what it imported", async () => {
    const env = { EXPLAINER_AUDIO_LIBRARY: lib("env") };
    await cli(importArgs("CC0-1.0"), env);

    const listed = await cli(["list"], env);

    expect(listed.out).toMatch(/^tone\tsfx\tCC0-1\.0\t1\.00\t-?\d+\.\d\tbeep,test\n$/);
  });
});
