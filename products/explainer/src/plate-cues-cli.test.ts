import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPlateCuesCli } from "./plate-cues-cli.js";

const board = {
  video_type: "sample-type",
  title: "A synthetic board",
  beats: [{ id: "beat-01", type: "hook", duration_s: 4, spoken: "Builds fail on a cold cache.", slots: { line: "Builds fail cold" }, cues: ["fail"] }],
};
const words = { beats: [{ id: "beat-01", durationS: 4.5, words: [{ word: "Builds", start: 0.1 }, { word: "fail", start: 0.4 }] }] };

const dirs: string[] = [];
function fixture(): { dir: string; beats: string; audio: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "plate-cues-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, "beats.json"), JSON.stringify(board));
  writeFileSync(join(dir, "words.json"), JSON.stringify(words));
  return { dir, beats: join(dir, "beats.json"), audio: dir, out: join(dir, "cues.json") };
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const run = async (argv: string[]) => {
  const err: string[] = [];
  const code = await runPlateCuesCli(argv, { out: () => undefined, err: (text) => err.push(text) });
  return { code, err: err.join("") };
};

describe("runPlateCuesCli", () => {
  it("exits 0 and writes the cues file", async () => {
    const f = fixture();

    const { code } = await run(["plate-cues", f.beats, "--audio", f.audio, "--out", f.out]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(f.out, "utf8")).beats[0].cues.fail).toBeCloseTo(0.4, 9);
  });

  it("exits 0 for a log on its cues and 1 for drift", async () => {
    const f = fixture();
    const log = join(f.dir, "log.json");
    writeFileSync(log, JSON.stringify([{ beat: "beat-01", cue: "fail", atS: 0.4 }]));
    const ok = await run(["plate-cues", f.beats, "--audio", f.audio, "--out", f.out, "--check", log]);
    writeFileSync(log, JSON.stringify([{ beat: "beat-01", cue: "fail", atS: 0.9 }]));

    const drift = await run(["plate-cues", f.beats, "--audio", f.audio, "--out", f.out, "--check", log]);

    expect(ok.code).toBe(0);
    expect(drift.code).toBe(1);
    expect(drift.err).toContain("beat-01");
  });

  it("exits 1 when the audio bundle is missing", async () => {
    const f = fixture();

    const { code } = await run(["plate-cues", f.beats, "--out", f.out]);

    expect(code).toBe(1);
  });

  it("exits 2 on usage errors", async () => {
    const f = fixture();

    const { code } = await run(["plate-cues", f.beats, "--audio", f.audio]);

    expect(code).toBe(2);
  });
});
