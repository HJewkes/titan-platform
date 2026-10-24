import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import { auditionOutputs } from "./calibration-auditions.js";
import { agreement, labelsFromFeedback, promotionRefusal, type AgreementRecord } from "./calibration-agreement.js";
import { buildQueue, CALIBRATION_JUDGES, QUEUE_SIZE, QueueKeySchema, type JudgedOutput, type KeyEntry, type QueueKey } from "./calibration-queue.js";
import { calibrationRound, MINUTES_PER_ITEM, type RoundCase } from "./calibration-round.js";
import { judgedOutputs, ManifestSchema } from "./calibration-sources.js";

const EXIT = { OK: 0, USAGE: 2 } as const;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
};

function guarded(name: string, onResult: (code: number) => void, body: () => void): void {
  try {
    body();
    onResult(EXIT.OK);
  } catch (error) {
    console.error(`calibrate ${name}: ${error instanceof Error ? error.message : String(error)}`);
    onResult(EXIT.USAGE);
  }
}

const countBy = (values: readonly string[]): Record<string, number> =>
  Object.fromEntries([...new Set(values)].sort().map((v) => [v, values.filter((x) => x === v).length]));

const PAIR_CONTEXT = "Each question shows two storyboards for one video: the opening line and the question each part answers, with its length.";

interface QueueFlags { roundDir: string; key: string; unit: string; size: string; seed: string }

function writeQueue(manifestPath: string, flags: QueueFlags): void {
  const roundFile = join(flags.roundDir, "round.json");
  if (existsSync(roundFile) || existsSync(flags.key)) throw new Error(`${roundFile} or ${flags.key} already exists; a published round is never rewritten`);
  const manifest = ManifestSchema.parse(readJson(manifestPath));
  const read = manifest.cases.map((entry) => ({ entry, ...judgedOutputs(entry) }));
  const outputs: JudgedOutput[] = [...read.flatMap((r) => r.outputs), ...manifest.auditions.flatMap((entry) => auditionOutputs(entry, flags.seed))];
  const queue = buildQueue(outputs, z.coerce.number().int().positive().parse(flags.size), flags.seed);
  if (queue.items.length === 0) throw new Error("no judged outputs outside the holdout; run the judges first");
  const cases = new Map<string, RoundCase>([
    ...manifest.auditions.map((a) => [a.case, { title: a.title, script: PAIR_CONTEXT }] as const),
    ...read.map((r) => [r.entry.case, { title: r.entry.title, script: r.script }] as const),
  ]);
  const key: QueueKey = { schema: "calibration-key/v1", round: flags.unit, entries: queue.key };
  writeJson(flags.key, key);
  writeJson(roundFile, calibrationRound(queue, { unit: flags.unit, cases }));
  const minutes = Math.round(queue.items.length * MINUTES_PER_ITEM);
  const by = (field: (k: KeyEntry) => string) => countBy(queue.key.map(field));
  const mix = { by_judge: by((k) => k.judge), by_video_type: by((k) => k.videoType), judge_verdicts: by((k) => `${k.judge}:${k.pass ? "pass" : "fail"}`) };
  console.log(JSON.stringify({ round: roundFile, items: queue.items.length, minutes, ...mix }));
}

export const queueCommand = (onResult: (code: number) => void): Command =>
  new Command("queue")
    .description("Build the blind judge-calibration queue from judged benches and write it as an owner console round")
    .argument("<manifest>", "calibration-manifest/v1 JSON naming each case's script, bench, video type and split")
    .requiredOption("--round-dir <dir>", "console round directory to write round.json into")
    .requiredOption("--key <file>", "where the hidden answer key goes; keep it outside the round directory")
    .requiredOption("--unit <id>", "the round's unit id")
    .option("--size <n>", "items in the queue", String(QUEUE_SIZE))
    .option("--seed <seed>", "fixes which outputs are drawn and their order", "tp-4012")
    .exitOverride()
    .action((manifest: string, flags: QueueFlags) => guarded("queue", onResult, () => writeQueue(manifest, flags)));

interface AgreementFlags { key: string; feedback: string; record?: string; format: "table" | "json" }

const fixed = (value: number | null): string => (value === null ? "-" : value.toFixed(2));

function formatRecord(record: AgreementRecord): string {
  const header = ["judge", "items", "labelled", "unsure", "agreed", "agreement", "fail_recall", "promotion"];
  const lines = record.judges.map((j) => [
    j.judge, j.items, j.labelled, j.unsure, j.agreed, fixed(j.agreement), fixed(j.fail_recall), promotionRefusal(j.judge, record) ?? "may be promoted",
  ].join("\t"));
  return [`round: ${record.round}`, header.join("\t"), ...lines].join("\n");
}

function reportAgreement(flags: AgreementFlags, now: () => Date): void {
  const key = QueueKeySchema.parse(readJson(flags.key));
  const labels = labelsFromFeedback(readJson(flags.feedback));
  const record: AgreementRecord = { schema: "judge-agreement/v1", round: key.round, recorded_at: now().toISOString(), judges: agreement(key.entries, labels) };
  if (flags.record) writeJson(flags.record, record);
  console.log(flags.format === "json" ? JSON.stringify(record) : formatRecord(record));
}

export const agreementCommand = (onResult: (code: number) => void, now: () => Date = () => new Date()): Command =>
  new Command("agreement")
    .description(`Score each judge (${CALIBRATION_JUDGES.join(", ")}) against the owner's labels from the round's feedback.json`)
    .requiredOption("--key <file>", "calibration-key/v1 written by `calibrate queue`")
    .requiredOption("--feedback <file>", "the round's feedback.json, where the console stores the owner's labels")
    .option("--record <file>", "write the judge-agreement/v1 record a promotion reads")
    .addOption(new Option("--format <format>", "output format").choices(["table", "json"]).default("table"))
    .exitOverride()
    .action((flags: AgreementFlags) => guarded("agreement", onResult, () => reportAgreement(flags, now)));
