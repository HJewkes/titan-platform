import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { WRITING_METRICS } from "./lint-writing.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { parseWritingCheck, type BucketName } from "./writing-calibrate.js";
import { scoreWriting, type WritingBeat } from "./writing-check.js";
import type { WritingStatus } from "./writing-status.js";

const SHIPPED = readFileSync(new URL("../doctrine/writing-check.json", import.meta.url), "utf8");
const BUCKETS: readonly BucketName[] = ["150-299", "300-599", "600-1199", "1200+", "full"];
const CLEAN_LINE = "The parser reads each record and hands it to the queue for the next worker.";

/** The shipped table with one row's status forced at every length, so a recalibration cannot move these tests. */
function tableWith(statuses: Partial<Record<(typeof WRITING_METRICS)[number], WritingStatus>>) {
  const table = parseWritingCheck(SHIPPED);
  for (const metric of WRITING_METRICS) {
    for (const bucket of BUCKETS) table.statusByBucket[metric][bucket] = statuses[metric] ?? "report-only";
  }
  return table;
}

const beatsOf = (lines: readonly string[]): WritingBeat[] => lines.map((spoken, i) => ({ id: `b${i + 1}`, spoken }));
const cleanLines = (count: number): string[] => Array.from({ length: count }, () => CLEAN_LINE);
const row = (report: ReturnType<typeof scoreWriting>, metric: (typeof WRITING_METRICS)[number]) => report.rows.find((candidate) => candidate.metric === metric)!;

describe("scoreWriting", () => {
  it("reports neg-synthetic FAIL with its span when a 250-word script says \"no file\"", () => {
    const beats = beatsOf([...cleanLines(16), "The loader stops here with no file on disk."]);

    const report = scoreWriting(beats, tableWith({ "neg-synthetic": "gate" }));

    expect(row(report, "neg-synthetic")).toMatchObject({ status: "gate", verdict: "fail", spans: [{ beat: "b17", text: "no file" }] });
  });

  it("finds up to three separate spans, one per hit, across beats", () => {
    const hits = ["It has no cache and no queue.", "It reads only the log.", "Nor does it retry and neither does the proxy."];
    const beats = beatsOf([...cleanLines(16), ...hits]);

    const report = scoreWriting(beats, tableWith({ "neg-synthetic": "warning" }));

    expect(row(report, "neg-synthetic").spans).toEqual([{ beat: "b17", text: "no cache" }, { beat: "b17", text: "no queue" }, { beat: "b19", text: "Nor" }]);
  });

  it("picks the row's status from the script's own length bucket", () => {
    const table = tableWith({});
    table.statusByBucket.triads["150-299"] = "gate";
    table.statusByBucket.triads["300-599"] = "drop";

    const short = scoreWriting(beatsOf(cleanLines(14)), table);
    const longer = scoreWriting(beatsOf(cleanLines(30)), table);

    expect(short.bucket).toBe("150-299");
    expect(row(short, "triads").status).toBe("gate");
    expect(longer.bucket).toBe("300-599");
    expect(row(longer, "triads").status).toBe("drop");
  });

  it("does not fail a gate row the text cannot carry, and counts it as unmeasured", () => {
    const unpunctuated = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");

    const report = scoreWriting(beatsOf([unpunctuated]), tableWith({ triads: "gate" }));

    expect(row(report, "triads").verdict).toBe("unmeasured");
    expect(report.verdict).toMatchObject({ pass: true, gatesUnmeasured: 1 });
  });

  it("fails a flat script on adjacent-delta in the rhythm group, as a shape with no span to quote", () => {
    const report = scoreWriting(beatsOf(cleanLines(14)), tableWith({ "adjacent-delta": "warning" }));

    expect(row(report, "adjacent-delta")).toMatchObject({ dimension: "rhythm", value: 0, status: "warning", verdict: "fail", spans: [] });
    expect(report.verdict).toMatchObject({ pass: true, warnings: 1 });
  });

  it("passes adjacent-delta on a script whose sentence lengths step around", () => {
    const steps = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? CLEAN_LINE : "It stops."));

    const report = scoreWriting(beatsOf([...steps, ...steps]), tableWith({ "adjacent-delta": "warning" }));

    expect(row(report, "adjacent-delta").verdict).toBe("pass");
  });

  it("places every writing metric in a dimension exactly once", () => {
    const report = scoreWriting(beatsOf(cleanLines(14)), tableWith({}));

    expect(report.rows.map((candidate) => candidate.metric).sort()).toEqual([...WRITING_METRICS].sort());
  });
});

describe("human standing", () => {
  const LINEAR = Array.from({ length: 21 }, (_, i) => i);
  const standing = (curve: number[], lines: readonly string[] = cleanLines(14)) => {
    const table = tableWith({});
    table.humanQuantiles["neg-synthetic"]["150-299"] = { n: 40, clusters: 9, values: curve };
    return row(scoreWriting(beatsOf(lines), table), "neg-synthetic");
  };

  it("reads a value back through the quantile curve", () => {
    const { value, human } = standing(LINEAR, [...cleanLines(13), "The loader stops here with no file on disk."]);

    expect(human?.percentile).toBe(Math.round(5 * (value ?? 0)));
  });

  it("gives a two-sided row a percentile too, and keeps its band's flag rate beside it", () => {
    const table = tableWith({});
    table.rows.numbers["150-299"].fpr_heldout = { ...table.rows.numbers["150-299"].fpr_heldout, point: 0.6, n: 100 };
    table.humanQuantiles.numbers["150-299"] = { n: 100, clusters: 9, values: LINEAR.map((n) => n - 100) };

    expect(row(scoreWriting(beatsOf(cleanLines(14)), table), "numbers").human).toEqual({ flaggedShare: 0.6, windows: 100, percentile: 100 });
  });

  it("puts a value above every human window at p100 and one below them all at p0", () => {
    expect(standing(LINEAR.map((n) => n - 100)).human?.percentile).toBe(100);
    expect(standing(LINEAR.map((n) => n + 1)).human?.percentile).toBe(0);
  });

  it("gives a 0 on a row most humans score 0 on the share of humans at 0, not p0", () => {
    const mostlyZero = [...Array.from({ length: 18 }, () => 0), 1, 2, 3];

    expect(standing(mostlyZero).human?.percentile).toBe(85);
  });
});

describe("explainer eval writing", () => {
  let dir: string;
  let printed: string[];
  const write = (name: string, value: string): string => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const tableFile = (statuses: Parameters<typeof tableWith>[0]): string => write("table.json", JSON.stringify(tableWith(statuses)));
  const failing = (): string => write("script.txt", [...cleanLines(16), "The loader stops here with no file on disk."].join("\n"));
  const output = (): string => printed.join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "writing-check-"));
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("exits 1 only when a gate row fails: the same breach on a warning or report-only row exits 0", async () => {
    const script = failing();
    const run = (status: WritingStatus) => runEvalCli(["eval", "writing", script, "--format", "text", "--table", tableFile({ "neg-synthetic": status })]);

    expect(await run("gate")).toBe(1);
    expect(await run("warning")).toBe(0);
    expect(await run("report-only")).toBe(0);
    expect(await run("drop")).toBe(0);
  });

  it("reports a 120-word script and never fails it, and says why", async () => {
    const script = write("short.txt", [...cleanLines(8), "It has no cache."].join("\n"));

    const code = await runEvalCli(["eval", "writing", script, "--format", "text", "--table", tableFile({ "neg-synthetic": "gate" })]);

    expect(code).toBe(0);
    expect(output()).toContain("under 150 words: every row is reported only and none can fail");
    expect(output()).not.toContain("FAIL");
  });

  it("reads text format as one beat per line, naming each beat by its line", async () => {
    const script = write("script.txt", `${cleanLines(16).join("\n")}\n\nThe loader stops here with no file on disk.\n`);

    await runEvalCli(["eval", "writing", script, "--format", "text", "--json", "--table", tableFile({ "neg-synthetic": "gate" })]);

    const report = JSON.parse(output());
    expect(report.rows.find((candidate: { metric: string }) => candidate.metric === "neg-synthetic").spans).toEqual([{ beat: "line-18", text: "no file" }]);
  });

  it("states in the header that the human reference is speech transcripts, and prints the verdict with its exit code", async () => {
    await runEvalCli(["eval", "writing", failing(), "--format", "text", "--table", tableFile({ "neg-synthetic": "gate", triads: "warning", lets: "drop" })]);

    const [header] = output().split("\n");
    expect(header).toContain("human reference: speech transcripts, not written scripts");
    expect(output()).toContain("verdict: FAIL (1 gate row), 0 warnings, 12 report-only; exit 1");
    expect(output()).toMatch(/lets\s+dropped$/m);
    expect(output()).toMatch(/adjacent-delta\s+0\.\d\d\s+0\.55-3\s/);
  });

  it("prints a percentile, with its n only when under 20 held-out windows stand behind it", async () => {
    await runEvalCli(["eval", "writing", write("clean.txt", cleanLines(14).join("\n")), "--format", "text", "--table", tableFile({})]);

    expect(output()).toMatch(/^\s*\S*\s*triads\s+\S+\s+\S+\s+p\d+ n=15\s/m);
    expect(output()).toMatch(/^\s*\S*\s*phrases\s+\S+\s+\S+\s+p\d+\s+report/m);
  });

  it("reads a script/v1 file by default", async () => {
    const code = await runEvalCli(["eval", "writing", write("script.json", JSON.stringify(scriptWith())), "--table", tableFile({})]);

    expect(code).toBe(0);
    expect(output()).toContain("verdict: report only, under 150 words; exit 0");
  });

  it("writes nothing without --bench", async () => {
    const script = failing();
    const table = tableFile({});

    await runEvalCli(["eval", "writing", script, "--format", "text", "--table", table]);

    expect(readdirSync(dir).sort()).toEqual(["script.txt", "table.json"]);
  });

  it("appends one row per metric and a run record under --bench, keyed to the table", async () => {
    const times = [new Date("2026-10-13T10:00:00.000Z"), new Date("2026-10-13T10:00:02.000Z")];
    const bench = join(dir, "bench");

    await runEvalCli(["eval", "writing", failing(), "--format", "text", "--table", tableFile({ "neg-synthetic": "gate" }), "--bench", bench, "--config", "tour/writing"], { now: () => times.shift() ?? new Date(0) });

    const rows = readFileSync(join(bench, "evals/structure.tsv"), "utf8").trimEnd().split("\n").slice(1);
    expect(rows).toHaveLength(WRITING_METRICS.length);
    expect(rows).toContainEqual(expect.stringMatching(/\twriting:neg-synthetic\theuristic\terror\t[\d.]+\t2\.5\tfalse\tline-17$/));
    expect(JSON.parse(readFileSync(join(bench, "evals/runs.jsonl"), "utf8"))).toMatchObject({ config_id: "tour/writing", eval_id: "writing-check", usd: 0, wall_s: 2 });
  });

  it.each([
    ["an unknown format", ["--format", "docx"]],
    ["--bench without --config", ["--format", "text", "--bench", "bench"]],
  ])("exits 2 on %s", async (_name, extra) => {
    expect(await runEvalCli(["eval", "writing", failing(), ...extra])).toBe(2);
  });

  it("exits 2 on a missing script and writes nothing", async () => {
    const code = await runEvalCli(["eval", "writing", join(dir, "absent.json"), "--bench", join(dir, "bench"), "--config", "c"]);

    expect(code).toBe(2);
    expect(existsSync(join(dir, "bench"))).toBe(false);
  });
});
