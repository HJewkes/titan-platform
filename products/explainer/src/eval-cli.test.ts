import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { rulesSha, scriptSha } from "./eval-store.js";
import { layout } from "./map-fixtures.test-helpers.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const RULES = "rules:\n  - id: Q-D2\n";
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
  runEvalCli(["eval", "l0", script, "--config", "tour-short/script-v1-01", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra], { now: clock() });
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
    expect(rows).toHaveLength(8);
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

  it("exits 2 on a script that is not script/v1, and on a missing --rules", async () => {
    expect(await l0(write("bad.json", { schema: "script/v0" }))).toBe(2);
    expect(await runEvalCli(["eval", "l0", write("script.json", scriptWith()), "--config", "c"])).toBe(2);
  });
});
