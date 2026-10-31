import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { appendRun, appendTsv, benchLayout, deterministicRun, freezeScript, rulesSha, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { migrateSpike } from "./migrate.js";
import { parseScript } from "./script-load.js";
import { parseWritingCheck } from "./writing-calibrate.js";
import { scoreWriting, type WritingBeat, type WritingReport, type WritingRow } from "./writing-check.js";
import { formatWritingReport } from "./writing-check-format.js";

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
}

interface WritingCheckDeps {
  now?: () => Date;
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

/** Records the run the way `eval l0` does; `tableSha` stands in the rules_sha column, so rows from different tables never mix. */
function recordBench(dir: string, config: string, raw: unknown, report: WritingReport, table: { sha: string; started: Date; finished: Date }): void {
  const bench = benchLayout(dir);
  const script = freezeScript(bench, raw, null);
  appendTsv(bench.structure, STRUCTURE_COLUMNS, report.rows.map((row) => structureRow(row, { config, script, table: table.sha })));
  appendRun(bench, deterministicRun({ configId: config, scriptSha: script, parentSha: null, rulesSha: table.sha, evalId: WRITING_EVAL_ID, started: table.started, finished: table.finished }));
}

function evalWriting(file: string, flags: WritingFlags, now: () => Date): boolean {
  if (flags.bench !== undefined && flags.config === undefined) throw new Error("--bench needs --config <id>");
  const started = now();
  const tableBytes = readFileSync(flags.table ?? SHIPPED_TABLE);
  const tableSha = rulesSha(tableBytes);
  const { raw, beats } = readScript(file, flags.format);
  const report = scoreWriting(beats, parseWritingCheck(tableBytes.toString("utf8")));
  console.log(flags.json ? JSON.stringify({ script: file, tableSha, ...report }) : formatWritingReport(report, { script: file, tableSha }));
  if (flags.bench !== undefined) recordBench(flags.bench, flags.config ?? "", raw, report, { sha: tableSha, started, finished: now() });
  return report.verdict.pass;
}

export function writingCommand(deps: WritingCheckDeps, onResult: (code: number) => void): Command {
  return new Command("writing")
    .description("Score a script's AI-isms, rhythm and specificity against doctrine/writing-check.json at the script's length; $0, and writes nothing unless --bench is given")
    .argument("<script>", "script file")
    .addOption(new Option("--format <format>", "script/v1 JSON, a motion-spike script.json, or plain text with one beat per line").choices(FORMATS).default("v1"))
    .option("--json", "print the report as JSON")
    .option("--bench <dir>", "append structure.tsv rows and a runs.jsonl record to this bench; needs --config")
    .option("--config <id>", "config_id for the bench rows")
    .option("--table <file>", "writing-check JSON to score against, by default the shipped one")
    .exitOverride()
    .action((file: string, flags: WritingFlags) => {
      try {
        onResult(evalWriting(file, flags, deps.now ?? (() => new Date())) ? EXIT.OK : EXIT.FAILURE);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
