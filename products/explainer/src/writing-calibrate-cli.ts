import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { calibrateWriting, formatWritingCheck, type CorpusDoc, type WritingCheck } from "./writing-calibrate.js";
import { StatusThresholdsSchema, type StatusThresholds } from "./writing-status.js";

const EXIT = { OK: 0, USAGE: 2 } as const;
const COLUMNS = ["id", "path", "label", "set", "split", "cluster", "caption_kind", "words", "sha256_12"] as const;
const SHIPPED_CHECK = new URL("../doctrine/writing-check.json", import.meta.url);

const ManifestRowSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  label: z.enum(["human", "ai-other", "ours", "ours-new"]),
  set: z.string().min(1),
  split: z.enum(["train", "phrase-fit", "heldout"]),
  cluster: z.string().min(1),
});
const PrecisionSchema = z.record(z.string(), z.looseObject({ correct: z.number(), labelled: z.number() }));
const ThresholdsHolderSchema = z.looseObject({ meta: z.looseObject({ thresholds: StatusThresholdsSchema }) });

/** Every `spoken` string in a script JSON, in document order, however deep its beats sit. */
function spokenOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(spokenOf);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "spoken" && typeof value === "string" ? [value] : spokenOf(value)));
}

/** A corpus file's lines: `.json` as script JSON, anything else one beat per line. */
function linesOf(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  return path.endsWith(".json") ? spokenOf(JSON.parse(raw)) : raw.split("\n");
}

function manifestRows(raw: string) {
  const [header, ...lines] = raw.split("\n").filter(Boolean);
  if (header !== COLUMNS.join("\t")) throw new Error(`manifest header must be: ${COLUMNS.join(" ")}`);
  return lines.map((line) => {
    const cells = line.split("\t");
    return ManifestRowSchema.parse(Object.fromEntries(COLUMNS.map((column, i) => [column, cells[i]])));
  });
}

/** Reads the manifest and the corpus files it names. A relative path is taken from the manifest's own directory. */
export function loadCorpus(manifestPath: string): { docs: CorpusDoc[]; manifestSha256: string } {
  const raw = readFileSync(manifestPath);
  const docs = manifestRows(raw.toString("utf8")).map(({ id, path, label, set, cluster }) => {
    const tokens = linesOf(resolve(dirname(manifestPath), path)).join(" ").split(/\s+/).filter(Boolean);
    return { id, label, set, cluster, tokens };
  });
  return { docs, manifestSha256: createHash("sha256").update(raw).digest("hex") };
}

export const readThresholds = (path: string | URL): StatusThresholds => ThresholdsHolderSchema.parse(JSON.parse(readFileSync(path, "utf8"))).meta.thresholds;

export const readPrecision = (path: string): z.infer<typeof PrecisionSchema> => PrecisionSchema.parse(JSON.parse(readFileSync(path, "utf8")));

interface WritingCalibrateFlags {
  precision: string;
  sourceSha: string;
  out: string;
  thresholds?: string;
}

function runCalibration(manifest: string, flags: WritingCalibrateFlags): WritingCheck {
  const { docs, manifestSha256 } = loadCorpus(manifest);
  const thresholds = readThresholds(flags.thresholds ?? SHIPPED_CHECK);
  return calibrateWriting({ docs, thresholds, precision: readPrecision(flags.precision), manifestSha256, sourceSha: flags.sourceSha });
}

export function writingCalibrateCommand(onResult: (code: number) => void): Command {
  return new Command("writing-calibrate")
    .description("Derive per-row discrimination, human false-positive rates and statuses from a corpus manifest; writes numbers only, never corpus text")
    .argument("<manifest>", "corpus manifest TSV: id, path, label, set, split, cluster, caption_kind, words, sha256_12")
    .requiredOption("--precision <file>", "hand-labelled span precision per row, JSON of {correct, labelled}")
    .requiredOption("--source-sha <sha>", "commit of lint-register.ts these rows were measured with, recorded in the output")
    .requiredOption("--out <file>", "where to write writing-check JSON, usually doctrine/writing-check.json")
    .option("--thresholds <file>", "writing-check JSON to read meta.thresholds from, by default the shipped one")
    .exitOverride()
    .action((manifest: string, flags: WritingCalibrateFlags) => {
      try {
        const check = runCalibration(manifest, flags);
        writeFileSync(flags.out, formatWritingCheck(check));
        console.log(`wrote ${flags.out}: ${check.meta.docs} texts, manifest ${check.meta.manifestSha256.slice(0, 12)}`);
        onResult(EXIT.OK);
      } catch (error) {
        console.error(`writing-calibrate: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
