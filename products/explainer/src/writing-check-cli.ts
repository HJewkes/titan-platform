import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { createJudgeHarness, type JudgeConfig, type JudgeHarness } from "./eval-harness.js";
import { appendRun, appendTsv, benchLayout, deterministicRun, freezeScript, rulesSha, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { migrateSpike } from "./migrate.js";
import { parseScript } from "./script-load.js";
import { parseWritingCheck } from "./writing-calibrate.js";
import { scoreWriting, type WritingBeat, type WritingReport, type WritingRow } from "./writing-check.js";
import type { GateRow } from "./writing-gate.js";
import { formatWritingReport } from "./writing-check-format.js";
import { runWritingJudge, WritingJudgeConfigSchema, type WritingJudgeResult } from "./writing-judge.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;
const WRITING_EVAL_ID = "writing-check";
const SHIPPED_TABLE = new URL("../doctrine/writing-check.json", import.meta.url);
const FORMATS = ["v1", "spike", "text"] as const;
type WritingFormat = (typeof FORMATS)[number];

interface WritingFlags {
  format: WritingFormat;
  json?: boolean;
  bench?: string;
  config?: string;
  table?: string;
  judge?: string;
}

interface WritingCheckDeps {
  now?: () => Date;
  harness?: (config: JudgeConfig) => JudgeHarness;
}

/** The script as read, for freezing, and its beats. In text format each non-empty line is a beat, named by its line number. */
function readScript(file: string, format: WritingFormat): { raw: unknown; beats: WritingBeat[] } {
  const content = readFileSync(file, "utf8");
  if (format === "text") {
    const beats = content.split("\n").map((spoken, i) => ({ id: `line-${i + 1}`, spoken })).filter((beat) => beat.spoken.trim() !== "");
    return { raw: content, beats };
  }
  const raw: unknown = JSON.parse(content);
  return { raw, beats: (format === "spike" ? migrateSpike(raw) : parseScript(raw)).beats };
}

function structureRow(row: WritingRow, ids: { config: string; script: string; table: string }): StructureRow {
  return {
    config_id: ids.config, script_sha: ids.script, rules_sha: ids.table,
    check_id: `writing:${row.metric}`, mode: "heuristic", severity: row.status === "gate" ? "error" : "warning",
    value: row.value ?? 0, threshold: row.band.max, pass: row.verdict !== "fail",
    detail_beats: [...new Set(row.spans.map((span) => span.beat))],
  };
}

function gateStructureRow(row: GateRow, ids: { config: string; script: string; table: string }): StructureRow {
  return {
    config_id: ids.config, script_sha: ids.script, rules_sha: ids.table,
    check_id: row.id, mode: "heuristic", severity: row.severity === "error" ? "error" : "warning",
    value: row.value ?? 0, threshold: row.threshold, pass: row.pass, detail_beats: row.beats,
  };
}

/** Records the run the way `eval l0` does; `tableSha` stands in the rules_sha column, so rows from different tables never mix. */
function recordBench(dir: string, config: string, raw: unknown, report: WritingReport, table: { sha: string; started: Date; finished: Date }): void {
  const bench = benchLayout(dir);
  const script = freezeScript(bench, raw, null);
  const ids = { config, script, table: table.sha };
  appendTsv(bench.structure, STRUCTURE_COLUMNS, [...report.rows.map((row) => structureRow(row, ids)), ...report.gate.map((row) => gateStructureRow(row, ids))]);
  appendRun(bench, deterministicRun({ configId: config, scriptSha: script, parentSha: null, rulesSha: table.sha, evalId: WRITING_EVAL_ID, started: table.started, finished: table.finished }));
}

/** The model-measured rows, or none without --judge; the config is read before any call, so a bad file costs nothing. */
async function judgeWriting(beats: readonly WritingBeat[], flags: WritingFlags, deps: WritingCheckDeps): Promise<WritingJudgeResult | null> {
  if (flags.judge === undefined) return null;
  if (flags.bench !== undefined) throw new Error("--bench does not record judged rows yet; drop --bench or --judge");
  const config = WritingJudgeConfigSchema.parse(JSON.parse(readFileSync(flags.judge, "utf8")));
  return runWritingJudge({ beats, config, harnessFor: deps.harness ?? createJudgeHarness });
}

function judgeLine(run: WritingJudgeResult): string {
  const failures = run.failures.length > 0 ? `; ${run.failures.join("; ")}` : "";
  const trust = run.trusted ? "trusted" : "UNTRUSTED";
  const dropped = `dropped ${run.dropped.marks} marks and ${run.dropped.terms} terms`;
  return `judge ${run.judge}, extractor ${run.extractor}: ${trust}, canary marks ${run.canary_marks}, ${dropped}, $${run.spend.usd.toFixed(3)}${failures}`;
}

/** The judged rows already sit in the report's gate, so the `judged` block carries only the run's own record. */
function printReport(report: WritingReport, judged: WritingJudgeResult | null, source: { script: string; tableSha: string }, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify({ ...source, ...report, ...(judged ? { judged: { ...judged, rows: undefined } } : {}) }));
  else console.log([formatWritingReport(report, source), ...(judged ? [judgeLine(judged)] : [])].join("\n"));
}

async function evalWriting(file: string, flags: WritingFlags, deps: WritingCheckDeps): Promise<boolean> {
  if (flags.bench !== undefined && flags.config === undefined) throw new Error("--bench needs --config <id>");
  const now = deps.now ?? (() => new Date());
  const started = now();
  const tableBytes = readFileSync(flags.table ?? SHIPPED_TABLE);
  const tableSha = rulesSha(tableBytes);
  const { raw, beats } = readScript(file, flags.format);
  const judged = await judgeWriting(beats, flags, deps);
  const report = scoreWriting(beats, parseWritingCheck(tableBytes.toString("utf8")), judged?.rows ?? []);
  printReport(report, judged, { script: file, tableSha }, flags.json);
  if (flags.bench !== undefined) recordBench(flags.bench, flags.config ?? "", raw, report, { sha: tableSha, started, finished: now() });
  return report.verdict.pass;
}

export function writingCommand(deps: WritingCheckDeps, onResult: (code: number) => void): Command {
  return new Command("writing")
    .description("Score a script's AI-isms, rhythm and specificity against doctrine/writing-check.json at the script's length; $0 without --judge, and writes nothing unless --bench is given")
    .argument("<script>", "script file")
    .addOption(new Option("--format <format>", "script/v1 JSON, a motion-spike script.json, or plain text with one beat per line").choices(FORMATS).default("v1"))
    .option("--json", "print the report as JSON")
    .option("--bench <dir>", "append structure.tsv rows and a runs.jsonl record to this bench; needs --config")
    .option("--config <id>", "config_id for the bench rows")
    .option("--table <file>", "writing-check JSON to score against, by default the shipped one")
    .option("--judge <config>", "judge config JSON: adds the model-measured rows (hallmark marks, words per term); spends subscription usage")
    .exitOverride()
    .action(async (file: string, flags: WritingFlags) => {
      try {
        onResult((await evalWriting(file, flags, deps)) ? EXIT.OK : EXIT.FAILURE);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
