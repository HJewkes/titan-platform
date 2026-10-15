import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { z } from "zod";
import { calibrate, LabelsSchema, type Calibration, type CalibrationRow } from "./eval-calibrate.js";
import { readTsv } from "./eval-store.js";

const EXIT = { OK: 0, USAGE: 2 } as const;

interface CalibrateFlags {
  labels: string;
  scriptSha?: string;
  format: "table" | "json";
}

const RowSchema = z.object({
  check_id: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  pass: z.boolean(),
  detail_beats: z.array(z.string()),
  script_sha: z.string().optional(),
});
type Row = z.infer<typeof RowSchema>;

const fromTsv = (record: Record<string, string>): unknown => ({
  ...record,
  pass: record.pass === "true" ? true : record.pass === "false" ? false : record.pass,
  detail_beats: (record.detail_beats ?? "").split(",").filter(Boolean),
});

/** A `structure.tsv` from `eval l0`, or a JSON array of rows in the same shape. */
function readRows(path: string): Row[] {
  const raw = path.endsWith(".tsv") ? readTsv(path).map(fromTsv) : (JSON.parse(readFileSync(path, "utf8")) as unknown);
  return z.array(RowSchema).parse(raw);
}

function loadRows(files: readonly string[], scriptSha: string | undefined): CalibrationRow[] {
  const rows = files.flatMap(readRows);
  return scriptSha === undefined ? rows : rows.filter((row) => row.script_sha === scriptSha);
}

const fixed = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
const list = (values: readonly string[]): string => (values.length === 0 ? "-" : values.join(","));

export function formatCalibration(result: Calibration): string {
  const header = ["check", "ran", "tp", "fp", "borderline", "unlabelled", "precision", "recall", "missed"];
  const rows = result.checks.map((c) => [
    c.check, c.ran ? "yes" : "no", c.true_positives.length, c.false_positives.length, c.borderline.length,
    c.unlabelled.length, fixed(c.precision), fixed(c.recall), list(c.missed),
  ].join("\t"));
  const { named, caught, recall } = result.owner;
  const owner = `owner-named recall (error checks): ${caught.length}/${named.length} = ${fixed(recall)}; missed ${list(named.filter((id) => !caught.includes(id)))}`;
  return [`labels: ${result.script}`, header.join("\t"), ...rows, owner].join("\n");
}

export function calibrateCommand(onResult: (code: number) => void): Command {
  return new Command("calibrate")
    .description("Score check rows against a labelled set: precision and recall per check, and recall on the owner-named beats")
    .argument("<rows...>", "structure.tsv files, or JSON arrays of {check_id, severity, pass, detail_beats} rows")
    .requiredOption("--labels <file>", "labels/v1 JSON, e.g. fixtures/spike/redesign-explainer-v4/labels.json")
    .option("--script-sha <sha>", "score only rows for this script_sha")
    .addOption(new Option("--format <format>", "output format").choices(["table", "json"]).default("table"))
    .exitOverride()
    .action((files: string[], flags: CalibrateFlags) => {
      try {
        const labels = LabelsSchema.parse(JSON.parse(readFileSync(flags.labels, "utf8")));
        const result = calibrate(labels, loadRows(files, flags.scriptSha));
        console.log(flags.format === "json" ? JSON.stringify(result) : formatCalibration(result));
        onResult(EXIT.OK);
      } catch (error) {
        console.error(`calibrate: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
