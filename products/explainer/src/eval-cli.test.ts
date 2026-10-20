import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { mapLintCheck } from "./eval-l0.js";
import { rulesSha, scriptSha } from "./eval-store.js";
import { spineCheck } from "./lint-spine.js";
import { paceCheck } from "./lint-pace.js";
import { layout } from "./map-fixtures.test-helpers.js";
import { DEFAULT_RULES_PATH } from "./rules.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { v4FullScript } from "./spike-fixtures.test-helpers.js";

const RULES = "schema: rules/v1\nrules:\n  - { id: Q-D2, rule: one job per beat, fields: [beats.visual.job], owner_support: none, l0: { severity: error, status: pending, owner: SQ5 } }\n";
const fourBoxes = scriptWith({
  visual: {
    assertion: "Four parts at once",
    job: "map",
    map_state: { level: "containers", reveal: ["web", "api", "store", "queue"].map((id) => ({ id, atCue: "scan" })) },
  },
});

let dir: string;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const clock = () => {
  const times = [new Date("2026-10-13T10:00:00.000Z"), new Date("2026-10-13T10:00:01.500Z")];
  return () => times.shift() ?? new Date(0);
};
const l0 = (script: string, ...extra: string[]) =>
  runEvalCli(["eval", "l0", script, "--config", "tour-short/script-v1-01", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra], { now: clock(), checks: [mapLintCheck] });
const structureLines = () => readFileSync(join(dir, "bench/evals/structure.tsv"), "utf8").trimEnd().split("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-cli-"));
  write("rules.yaml", RULES);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval l0", () => {
  it("records a passing run: frozen script, one row per map rule carrying rules_sha, and a zero-cost run record", async () => {
    const script = write("script.json", scriptWith());

    const code = await l0(script, "--layout", write("layout.json", layout), "--parent", "0123456789ab");

    const sha = scriptSha(scriptWith());
    expect(code).toBe(0);
    expect(readdirSync(join(dir, "bench/scripts"))).toEqual([`${sha}.json`]);
    const rows = structureLines().slice(1).map((line) => line.split("\t"));
    expect(rows).toHaveLength(10);
    expect(rows.every(([config, s, rules]) => config === "tour-short/script-v1-01" && s === sha && rules === rulesSha(RULES))).toBe(true);
    const run = JSON.parse(readFileSync(join(dir, "bench/evals/runs.jsonl"), "utf8"));
    expect(run).toMatchObject({ script_sha: sha, parent_sha: "0123456789ab", rules_sha: rulesSha(RULES), eval_id: "L0-script", eval_version: rulesSha(RULES), usd: 0, wall_s: 1.5, started_at: "2026-10-13T10:00:00.000Z" });
  });

  it("fails a script whose beat reveals four new boxes, naming the beat", async () => {
    const code = await l0(write("script.json", fourBoxes), "--layout", write("layout.json", layout));

    expect(code).toBe(1);
    expect(structureLines()).toContainEqual(expect.stringMatching(/\tmap:new-boxes\ttagged\terror\t1\t0\tfalse\tc2-1-stations$/));
  });

  it("skips the map lints without a layout and still records the run", async () => {
    const code = await l0(write("script.json", fourBoxes));

    expect(code).toBe(0);
    expect(structureLines()).toEqual(["config_id\tscript_sha\trules_sha\tcheck_id\tmode\tseverity\tvalue\tthreshold\tpass\tdetail_beats"]);
    expect(readFileSync(join(dir, "bench/evals/runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reads heard durations from --timing, so a four-item beat voiced over 9 s is not rushed", async () => {
    const run = (...extra: string[]) =>
      runEvalCli(["eval", "l0", write("script.json", fourBoxes), "--config", "c", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra], { checks: [paceCheck] });
    const rushed = () => structureLines().filter((line) => line.includes("\tQ-E8\t")).map((line) => line.split("\t")[8]);

    await run();
    await run("--timing", write("words.json", { beats: [{ id: "c2-1-stations", durationS: 9 }] }));

    expect(rushed()).toEqual(["false", "true"]);
  });

  it("exits 2 on a script that is not script/v1, and on a registry that is not rules/v1", async () => {
    expect(await l0(write("bad.json", { schema: "script/v0" }))).toBe(2);
    write("rules.yaml", "rules:\n  - id: Q-D2\n");
    expect(await l0(write("script.json", scriptWith()))).toBe(2);
  });

  it("stamps rows with the shipped registry's sha when --rules is omitted", async () => {
    const script = write("script.json", scriptWith());

    expect(await runEvalCli(["eval", "l0", script, "--config", "c", "--bench", join(dir, "bench")], { now: clock(), checks: [mapLintCheck] })).toBe(0);
    const shipped = rulesSha(readFileSync(DEFAULT_RULES_PATH));
    expect(structureLines().slice(1).every((line) => line.split("\t")[2] === shipped)).toBe(true);
  });

  describe("--spine", () => {
    const PILOT_SPINE = join(__dirname, "../fixtures/spike/pipeline-explainer/spine.md");
    const spineRun = (...extra: string[]) =>
      runEvalCli(["eval", "l0", write("script.json", scriptWith()), "--config", "c", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra], { now: clock(), checks: [spineCheck] });

    // Mutation: parsing the spine but not passing it to runL0 leaves structure.tsv empty and the exit code 0.
    it("passes the parsed spine to the lints: the pilot spine's ch2 fails Q-E15 and exits 1", async () => {
      const code = await spineRun("--spine", PILOT_SPINE);

      expect(code).toBe(1);
      expect(structureLines()).toContainEqual(expect.stringMatching(/\tQ-E15\ttagged\terror\t1\t0\tfalse\tch2$/));
      expect(structureLines()).toContainEqual(expect.stringMatching(/\tQ-E18\ttagged\terror\t0\t0\ttrue$/));
    });

    it("records no spine rows without --spine", async () => {
      expect(await spineRun()).toBe(0);
      expect(structureLines()).toHaveLength(1);
    });

    it("exits 2 naming the file when the spine does not parse", async () => {
      const code = await spineRun("--spine", write("bad-spine.md", "# Story spine: x\n"));

      expect(code).toBe(2);
    });

    it("does not call Q-E15 or Q-E18 ghosts in a spine-free run", async () => {
      write("rules.yaml", "schema: rules/v1\nrules:\n  - { id: Q-E15, rule: synthetic, fields: [beats.spoken], owner_support: none, l0: { severity: error, status: implemented, checks: [Q-E15] } }\n");

      await spineRun();

      expect(vi.mocked(console.error).mock.calls.map(([line]) => String(line))).toEqual([]);
    });
  });

  describe("ghost check ids", () => {
    const GHOST = "schema: rules/v1\nrules:\n  - { id: Q-V9, rule: synthetic, fields: [beats.spoken], owner_support: none, l0: { severity: error, status: implemented, checks: [synthetic:ghost] } }\n";
    const CLEAN = "schema: rules/v1\nrules:\n  - { id: Q-V9, rule: synthetic, fields: [beats.visual.job], owner_support: none, l0: { severity: error, status: implemented, checks: [map:new-boxes] } }\n";
    const warnings = (): string[] => vi.mocked(console.error).mock.calls.map(([line]) => String(line));

    it("warns once naming a ghost id and still exits 0 by default", async () => {
      write("rules.yaml", GHOST);

      const code = await l0(write("script.json", scriptWith()), "--layout", write("layout.json", layout));

      expect(code).toBe(0);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("synthetic:ghost");
    });

    const rule = (id: string, checks: string): string => `  - { id: ${id}, rule: synthetic, fields: [beats.spoken], owner_support: none, l0: { severity: error, status: implemented, checks: [${checks}] } }\n`;

    it("does not call a skipped map lint a ghost when no layout is given", async () => {
      write("rules.yaml", `schema: rules/v1\nrules:\n${rule("Q-V9", "map:new-boxes, synthetic:ghost")}`);

      await l0(write("script.json", scriptWith()));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("synthetic:ghost");
      expect(warnings()[0]).not.toContain("map:");
    });

    it("names only the ghost when one rule claims an emitted id and a ghost id", async () => {
      write("rules.yaml", `schema: rules/v1\nrules:\n${rule("Q-V9", "map:new-boxes, synthetic:ghost")}`);

      await l0(write("script.json", scriptWith()), "--layout", write("layout.json", layout));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("synthetic:ghost");
    });

    it("warns once when a rule lists the same ghost id twice", async () => {
      write("rules.yaml", `schema: rules/v1\nrules:\n${rule("Q-V9", "synthetic:ghost, synthetic:ghost")}`);

      await l0(write("script.json", scriptWith()), "--layout", write("layout.json", layout));

      expect(warnings()).toHaveLength(1);
    });

    it("exits non-zero under --fail-on-ghosts", async () => {
      write("rules.yaml", GHOST);

      const code = await l0(write("script.json", scriptWith()), "--layout", write("layout.json", layout), "--fail-on-ghosts");

      expect(code).toBe(1);
    });

    it("stays silent when every claimed id is emitted", async () => {
      write("rules.yaml", CLEAN);

      const code = await l0(write("script.json", scriptWith()), "--layout", write("layout.json", layout), "--fail-on-ghosts");

      expect(code).toBe(0);
      expect(warnings()).toEqual([]);
    });
  });
});

describe("explainer eval l0 --format", () => {
  const spikeL0 = (script: string, ...extra: string[]) =>
    runEvalCli(["eval", "l0", script, "--config", "spike/v4", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra], { now: clock() });
  const checkIds = () => new Set(structureLines().slice(1).map((line) => line.split("\t")[3]));

  // Mutation: defaulting --format to v1 for this call makes ScriptSchema throw on the spike file, so the exit is 2.
  it("runs the voice, flow and pace checks on a spike script", async () => {
    const code = await spikeL0(write("spike.json", v4FullScript()), "--format", "spike");

    expect(code).toBe(1);
    expect([...checkIds()]).toEqual(expect.arrayContaining(["Q-V1", "Q-F1", "Q-E7"]));
  });

  it("reads a spike script as script/v1 by default and exits 2", async () => {
    const code = await spikeL0(write("spike.json", v4FullScript()));

    expect(code).toBe(2);
  });

  it("rejects an unknown format", async () => {
    expect(await spikeL0(write("spike.json", v4FullScript()), "--format", "tour")).toBe(2);
  });
});
