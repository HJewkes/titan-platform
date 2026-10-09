import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { appendSamples, healthSampleSchema, openHealthStore, type HealthSampleInput } from "@titan-design/health";
import type { ReportIo } from "./cli-uptime.js";

const SOURCE = "import:shepherd-health";
/** Exit 2: the file could not be read or the store could not be written, so nothing was imported. */
const EXIT_IMPORT = 2;

// The stopgap shell script wrote these with sed, so the optional fields are taken as they come.
const stopgapRowSchema = z.object({
  ts: z.string(),
  up: z.boolean(),
  code: z.unknown().optional(),
  secs: z.number().optional(),
  sha: z.unknown().optional(),
  running: z.unknown().optional(),
  pendingGates: z.unknown().optional(),
});
type StopgapRow = z.infer<typeof stopgapRowSchema>;

export interface ParsedStopgap {
  samples: HealthSampleInput[];
  bad: number;
}

function definedEntries(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

function toSample(row: StopgapRow, target: string, dedupKey: string): HealthSampleInput {
  const observed = definedEntries({ code: row.code, "build.sha": row.sha, running: row.running, pendingGates: row.pendingGates });
  return {
    ts: row.ts,
    target,
    kind: "http",
    status: row.up ? "pass" : "fail",
    ...(row.secs === undefined ? {} : { latencyMs: row.secs * 1000 }),
    ...(Object.keys(observed).length === 0 ? {} : { observed }),
    source: SOURCE,
    dedupKey,
  };
}

function parseLine(line: string, fileName: string, target: string): HealthSampleInput | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const row = stopgapRowSchema.safeParse(json);
  if (!row.success) return null;
  // The key is the file and the raw line, so a re-import of the same file is a no-op whenever it runs.
  const dedupKey = createHash("sha256").update(`${fileName}\n${line}`).digest("hex");
  const sample = toSample(row.data, target, dedupKey);
  return healthSampleSchema.safeParse(sample).success ? sample : null;
}

/** Maps stopgap JSONL rows to samples; a bad line is counted and skipped, and blank lines are ignored. */
export function parseStopgap(text: string, fileName: string, target: string): ParsedStopgap {
  const parsed: ParsedStopgap = { samples: [], bad: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const sample = parseLine(line, fileName, target);
    if (sample) parsed.samples.push(sample);
    else parsed.bad += 1;
  }
  return parsed;
}

function importFile(file: string, target: string, dbPath: string): ParsedStopgap & { imported: number } {
  const parsed = parseStopgap(readFileSync(file, "utf8"), basename(file), target);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openHealthStore(dbPath);
  try {
    return { ...parsed, imported: appendSamples(db, parsed.samples) };
  } finally {
    db.close();
  }
}

function runImport(file: string, target: string, dbPath: string, io: ReportIo): number {
  let result: ReturnType<typeof importFile>;
  try {
    result = importFile(file, target, dbPath);
  } catch (error) {
    io.stderr(`titan: could not import ${file} into ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_IMPORT;
  }
  const duplicate = result.samples.length - result.imported;
  io.stdout(`imported ${result.imported}, duplicate ${duplicate}, bad ${result.bad} from ${file} as ${target}\n`);
  return 0;
}

export function registerImport(health: Command, io: ReportIo, defaultDbPath: () => string): void {
  health
    .command("import")
    .argument("<jsonl>", "shepherd-health stopgap log")
    .description("Import the shepherd-health stopgap's JSONL rows; importing the same file again adds nothing")
    .option("--target <name>", "target the rows describe", "factory")
    .option("--db <path>", "health store (default: $XDG_STATE_HOME/titan/health.sqlite3)")
    .action((file: string, opts: { target: string; db?: string }) =>
      io.setExitCode(runImport(file, opts.target, opts.db ?? defaultDbPath(), io)),
    );
}
