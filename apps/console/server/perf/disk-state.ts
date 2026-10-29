// The perf fixture's on-disk half: a rounds dir, a deposit spool and agent-chat's events.db, all synthetic.
import { utimesSync } from "node:fs";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { depositItemId } from "@titan-design/owner-queue";
import { withdrawnFileName, writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { WITHDRAW_LOG } from "@titan-design/owner-queue/withdraw";
import { openDatabase } from "@titan-design/store-sqlite";
import { FEEDBACK_SCHEMA_ID, MANIFEST_SCHEMA_ID } from "../review-schema-0.3/index.js";
import { FEEDBACK_FILE, WITHDRAWN_FILE, WITHDRAWN_SCHEMA_ID } from "../rounds.js";
import type { BrokerState } from "./broker-state.js";
import { dateAt, draw, pad, WORDS, type Draw } from "./random.js";

export const DISK_SIZES = { rounds: 500, deposits: 400, withdrawnDeposits: 150, answeredDeposits: 100, askers: 40 } as const;

/** review-schema refuses an option text two questions of one round share, so each question's options name it. */
const optionsOf = (questionId: string): string[] => ["Keep", "Change", "Drop"].map((verb) => `${verb} ${questionId}`);

/** Every file gets a seeded mtime as well as seeded bytes: the console orders rounds and deposits by mtime. */
async function writePinned(file: string, data: string, at: Date, mode?: number): Promise<void> {
  await writeFile(file, data, mode === undefined ? {} : { mode });
  await utimes(file, at, at);
}

function roundManifest(random: Draw, id: string) {
  const questionIds = Array.from({ length: 1 + random.int(4) }, (_, index) => `q${index + 1}`);
  const questions = questionIds.map((questionId) => ({ id: questionId, kind: "pick-one", prompt: `Which way for ${questionId} of ${id}?`, options: optionsOf(questionId), required: true, signsOff: "part" }));
  const parts = [{ id: "part", label: "The change", proposed: `${random.pick(WORDS)}()`, lang: "ts" }];
  const sections = [{ id: "all", title: "All", deciding: "Which way it goes", changed: "The synthetic part", context: "Synthetic round", parts, questionIds }];
  return { schema: MANIFEST_SCHEMA_ID, unit: id, round: 1, storybookUrl: "http://127.0.0.1:6006", widths: [1280], variants: [], recommendations: "after-answer", sections, questions };
}

/** Frame metadata only: the shots it names are never written, so the fixture carries no media blobs. */
function framesJson(random: Draw, id: string): string {
  const frames = Array.from({ length: 3 + random.int(6) }, (_, index) => ({ key: `frame-${index}`, variant: `frame-${index}`, viewport: { width: 320, height: 180 }, file: `shots/frame-${index}.png`, sha256: pad(index, 64) }));
  return JSON.stringify({ schema: "titan-review/frames@1", unit: id, round: 1, frames });
}

function feedbackJson(manifest: ReturnType<typeof roundManifest>, at: string): string {
  const answers = manifest.questions.map((question) => ({ questionId: question.id, pick: question.options[0], agreed: true }));
  return JSON.stringify({ schema: FEEDBACK_SCHEMA_ID, unit: manifest.unit, round: 1, manifestSha256: "0".repeat(64), submittedAt: at, answers, variants: [], general: "" });
}

/** Half open, about a third answered, the rest withdrawn; mtimes are set so `updatedAt` is the same on every build. */
async function writeRound(random: Draw, roundsDir: string, index: number): Promise<void> {
  const id = `perf-round-${pad(index)}`;
  const roundDir = path.join(roundsDir, id);
  const manifest = roundManifest(random, id);
  const at = dateAt(-index);
  const status = random.pick(["open", "open", "open", "answered", "answered", "withdrawn"] as const);
  await mkdir(roundDir, { recursive: true });
  await writePinned(path.join(roundDir, "round.json"), JSON.stringify(manifest), at);
  if (random.chance(0.6)) {
    await mkdir(path.join(roundDir, "frames"));
    await writePinned(path.join(roundDir, "frames", "frames.json"), framesJson(random, id), at);
  }
  if (status === "answered") await writePinned(path.join(roundDir, FEEDBACK_FILE), feedbackJson(manifest, at.toISOString()), at);
  if (status === "withdrawn") await writePinned(path.join(roundDir, WITHDRAWN_FILE), `${JSON.stringify({ schema: WITHDRAWN_SCHEMA_ID, reason: "closed", at: at.toISOString() })}\n`, at);
}

export async function writeRounds(seed: string, roundsDir: string): Promise<void> {
  const random = draw(`${seed}:rounds`);
  for (let index = 0; index < DISK_SIZES.rounds; index += 1) await writeRound(random, roundsDir, index);
}

async function writeOneDeposit(random: Draw, spoolDir: string, index: number): Promise<string> {
  const asker = `seat-${pad(index % DISK_SIZES.askers, 2)}`;
  const depositId = `perf-${pad(index)}`;
  const { file } = await writeDeposit(spoolDir, {
    depositId,
    asker,
    kind: random.pick(["decide", "approve", "do", "review"] as const),
    door: "two-way",
    summary: `Synthetic deposit ${index}: ${random.pick(WORDS)} ${random.pick(WORDS)}`,
    context: "Synthetic deposit context. ".repeat(1 + random.int(10)),
    keys: [`perf:${index}`],
    ...(random.chance(0.4) && { unblocksNow: `seat work item ${index}` }),
  });
  await utimes(file, dateAt(-index), dateAt(-index));
  return depositItemId(asker, depositId);
}

async function closeDeposit(spoolDir: string, id: string, index: number): Promise<void> {
  const at = dateAt(-index + 1);
  if (index < DISK_SIZES.withdrawnDeposits) {
    const withdrawal = { reason: "obsolete", by: `seat-${pad(index % DISK_SIZES.askers, 2)}`, actor: "perf-fixture", at: at.toISOString() };
    await writePinned(path.join(spoolDir, withdrawnFileName(id)), `${JSON.stringify(withdrawal)}\n`, at, 0o600);
    await appendFile(path.join(spoolDir, WITHDRAW_LOG), `${JSON.stringify({ op: "withdraw", id, ...withdrawal })}\n`, { mode: 0o600 });
  } else if (index < DISK_SIZES.withdrawnDeposits + DISK_SIZES.answeredDeposits) {
    const { file } = await writeAnswer(spoolDir, id, { optionId: "ok", by: { class: "owner", id: "owner", channel: "console" }, at: at.toISOString() });
    await utimes(file, at, at);
  }
}

/** The first `withdrawnDeposits` are withdrawn the way `withdraw` leaves them (marker plus log line), the next `answeredDeposits` answered. */
export async function writeSpool(seed: string, spoolDir: string): Promise<void> {
  const random = draw(`${seed}:spool`);
  await mkdir(spoolDir, { recursive: true });
  for (let index = 0; index < DISK_SIZES.deposits; index += 1) await closeDeposit(spoolDir, await writeOneDeposit(random, spoolDir, index), index);
  await utimes(path.join(spoolDir, WITHDRAW_LOG), dateAt(0), dateAt(0));
}

/** agent-chat's events table, the columns `agents.messages` reads; written without WAL so the file's bytes are the whole state. */
export function writeEventsDb(file: string, state: BrokerState): void {
  const db = openDatabase(file, { wal: false, foreignKeys: false });
  try {
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)");
    const insert = db.prepare("INSERT INTO events (id, ts, kind, actor, target, msg_id, ref, body, meta) VALUES (@id, @ts, @kind, @actor, @target, @msgId, NULL, @body, NULL)");
    db.transaction(() => state.messages.forEach((message) => insert.run(message)))();
  } finally {
    db.close();
  }
  utimesSync(file, dateAt(0), dateAt(0));
}
