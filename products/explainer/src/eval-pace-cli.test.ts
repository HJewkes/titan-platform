import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LabelsSchema } from "./eval-calibrate.js";
import { runEvalCli } from "./eval-cli.js";
import { scriptSha } from "./eval-store.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { pipelineLabels, pipelineScript, v4Durations, v4Script } from "./spike-fixtures.test-helpers.js";

const spikeBeat = (id: string, titles: string[]) => ({
  id,
  chapter: "ch1",
  function: "EXPLAIN",
  plannedS: 8,
  spoken: "Four parts arrive at once.",
  visual: { titles },
});
const spike = (...beats: ReturnType<typeof spikeBeat>[]) => ({ id: "synthetic-spike", beats });
const FOUR_PARTS = ["Scanner", "Desk server", "Ledger", "Queue"];
const fourBoxes = scriptWith({
  visual: {
    assertion: "Four parts at once",
    job: "map",
    map_state: { level: "containers", reveal: ["web", "api", "store", "queue"].map((id) => ({ id, atCue: "scan" })) },
  },
});

let dir: string;
let log: MockInstance<typeof console.log>;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const clock = () => {
  const times = [new Date("2026-10-14T10:00:00.000Z"), new Date("2026-10-14T10:00:00.250Z")];
  return () => times.shift() ?? new Date(0);
};
const pace = (script: string, ...extra: string[]) => runEvalCli(["eval", "pace", script, "--bench", join(dir, "bench"), ...extra], { now: clock() });
const printed = (): string => log.mock.calls.map((call) => String(call[0])).join("\n");
const structureRows = () =>
  readFileSync(join(dir, "bench/evals/structure.tsv"), "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
const row = (checkId: string) => structureRows().find((cells) => cells[3] === checkId);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-pace-cli-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval pace", () => {
  it("fails the v4 spike script on its overcrowded beats and prints ch2 at 30.7 items a minute", async () => {
    const code = await pace(write("script.json", v4Script()), "--timing", write("words.json", v4Durations()));

    expect(code).toBe(1);
    expect(printed()).toContain("ch2\t20\t39.1\t30.7\tfail");
    expect(row("Q-E7")?.slice(5, 9)).toEqual(["error", expect.any(String), "0", "false"]);
    expect(row("Q-E10")?.[9]).toBe("ch2,ch3");
  });

  it("fails the v4 spike script's unseated invariant, routes r2-4, and prints the reused beats to re-voice", async () => {
    await pace(write("script.json", v4Script()), "--timing", write("words.json", v4Durations()));

    expect(row("Q-E11")?.slice(5, 9)).toEqual(["error", "1", "0", "false"]);
    expect(row("Q-E11")?.[9]).toBe("r2-2-inv");
    expect(row("Q-E12")?.[9]).toBe("r2-4-measure");
    expect(printed()).toContain("beat\tchecks\trevoice_s");
    expect(printed()).toMatch(/r2-1-jobs\tQ-E7[^\t]*\t\d+\.\d/);
  });

  it("prints no reused table when no reused beat fails", async () => {
    await pace(write("script.json", spike(spikeBeat("b1-parts", FOUR_PARTS))));

    expect(printed()).not.toContain("revoice_s");
  });

  // Mutation: mapping col to attribute drops c3-6's "owns" and c8-1's "agents", and the frozen ch3 and ch8 rows fail.
  it("fails the pipeline-explainer hold-out on exactly its labelled Q-E7 beats, with ch2 under 20 items a minute", async () => {
    const m1 = LabelsSchema.parse(pipelineLabels()).checks.find((c) => c.check === "M1");

    const code = await pace(write("script.json", pipelineScript()));

    expect(code).toBe(1);
    expect(row("Q-E7")?.slice(5)).toEqual(["error", "2", "0", "false", m1?.true.join(",")]);
    expect(printed()).toContain(
      ["ch1\t5\t36.0\t8.3", "ch2\t13\t72.0\t10.8", "ch3\t12\t66.0\t10.9", "ch4\t15\t106.0\t8.5", "ch5\t11\t50.0\t13.2",
        "ch6\t23\t176.0\t7.8", "ch7\t22\t134.0\t9.9", "ch8\t5\t31.0\t9.7", "ch9\t1\t13.0\t4.6"].map((r) => `${r}\tpass`).join("\n"),
    );
  });

  // Mutation: reverting Q-E9 to a warning changes the severity cell; flagging a pilot beat fails the "0" count.
  it("records Q-E9 as an error row that flags no pilot beat, on planned lengths", async () => {
    await pace(write("script.json", pipelineScript()));

    expect(row("Q-E9")?.slice(5, 9)).toEqual(["error", "0", "0", "true"]);
  });

  it("passes a spike script whose only failures are warnings, still recording them as failing rows", async () => {
    const code = await pace(write("script.json", spike(spikeBeat("b1-parts", FOUR_PARTS))));

    expect(code).toBe(0);
    expect(row("Q-E7")?.slice(5, 9)).toEqual(["error", "0", "0", "true"]);
    expect(row("Q-E8")?.slice(5)).toEqual(["warning", "1", "0", "false", "b1-parts"]);
    expect(row("Q-E10")?.slice(5)).toEqual(["warning", "1", "0", "false", "ch1"]);
    expect(printed()).toContain("ch1\t4\t8.0\t30.0\tfail");
  });

  it("fails a spike script when one beat puts a fifth new item on screen", async () => {
    const code = await pace(write("script.json", spike(spikeBeat("b1-parts", [...FOUR_PARTS, "Printer"]))));

    expect(code).toBe(1);
    expect(row("Q-E7")?.slice(5)).toEqual(["error", "1", "0", "false", "b1-parts"]);
  });

  it("records only the pace rows, under the default config, with an L0-pace run record", async () => {
    const script = spike(spikeBeat("b1-parts", FOUR_PARTS));

    await pace(write("script.json", script));

    expect(structureRows().map((cells) => cells[3])).toEqual(["Q-E7", "Q-E8", "Q-E9", "Q-E10", "Q-E11", "Q-E12", "Q-E13", "Q-E14"]);
    expect(structureRows().every(([config, sha]) => config === "unconfigured" && sha === scriptSha(script))).toBe(true);
    const run = JSON.parse(readFileSync(join(dir, "bench/evals/runs.jsonl"), "utf8"));
    expect(run).toMatchObject({ config_id: "unconfigured", script_sha: scriptSha(script), eval_id: "L0-pace", usd: 0, wall_s: 0.25 });
  });

  it("reads a script/v1 file under --format v1, and heard durations replace its planned lengths", async () => {
    const script = write("script.json", fourBoxes);

    expect(await pace(script, "--format", "v1", "--config", "tour-short/script-v1-01")).toBe(0);
    expect(row("Q-E7")?.[0]).toBe("tour-short/script-v1-01");
    expect(printed()).toContain("ch2\t4\t14.0\t17.1\tpass");
    log.mockClear();

    await pace(script, "--format", "v1", "--timing", write("words.json", { beats: [{ id: "c2-1-stations", durationS: 9 }] }));

    expect(printed()).toContain("ch2\t4\t9.0\t26.7\tfail");
  });

  it("exits 2 when a spike script is read as strict script/v1, and writes no rows", async () => {
    const code = await pace(write("script.json", v4Script()), "--format", "v1");

    expect(code).toBe(2);
    expect(() => structureRows()).toThrow();
  });
});
