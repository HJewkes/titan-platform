/**
 * The console's record of every owner answer it routes: one decider-readable ledger row per answer
 * in `<state>/answers.jsonl`, and, for one-way, A/B and policy answers only, one bullet under
 * `## Queue answers <date>` in the owner's decisions file. That file's path comes only from config.
 *
 * Personal items write nothing, and an unknown human-only list counts as personal (fail closed).
 * `record` never throws: a failed write is a result with a reason from a fixed vocabulary, never a
 * path or errno text, because the result goes to a LAN caller. The daemon log gets the full error.
 */
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LedgerRowSchema, isExcluded, type LedgerRowWire } from "@titan-design/decider";
import type { OwnerAnswer, OwnerItem } from "@titan-design/owner-queue";

export const ANSWERS_FILE = "answers.jsonl";
const TAIL_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 600;
const LEDGER_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
/** Never O_CREAT: a missing decisions file is reported, not created somewhere unexpected. */
const DECISIONS_FLAGS = constants.O_RDWR | constants.O_APPEND;

/** The OwnerItem fields the log reads, so a round answer can be logged without a full queue item. */
export type DecisionItem = Pick<
  OwnerItem,
  "id" | "sources" | "kind" | "door" | "class" | "category" | "summary" | "options" | "recommended" | "keys" | "initiative" | "personal" | "route"
> & { openedAt?: string };
export type DecisionAnswer = Pick<OwnerAnswer, "optionId" | "optionIds" | "text" | "changeRequested" | "by" | "at">;
type DecisionsClass = "one-way" | "a-b" | "policy";
export type HumanOnly = { known: false } | { known: true; initiatives: ReadonlySet<string> };

const REASONS = ["personal", "human-only unknown", "human-only-initiative", "ledger write failed", "decisions write failed", "decisions file missing"] as const;
type Reason = (typeof REASONS)[number];

export const decisionLogResult = z.object({
  ledger: z.enum(["written", "excluded", "failed"]),
  decisions: z.enum(["written", "not-a-decision", "excluded", "not-configured", "failed"]),
  reason: z.enum(REASONS).optional(),
});
export type DecisionLogResult = z.infer<typeof decisionLogResult>;

type LogLogger = { warn(fields: Record<string, unknown>, message: string): void };

interface DecisionLogOptions {
  stateDir: string;
  /** Owner-configured; never from a request. Null writes the ledger only. */
  decisionsFile: string | null;
  humanOnly: () => Promise<HumanOnly>;
  /** The decisions heading's date for an answer time; defaults to the host's local date. */
  today?: (at: string) => string;
  logger?: LogLogger;
}

export interface DecisionLog {
  record(item: DecisionItem, answer: DecisionAnswer): Promise<DecisionLogResult>;
}

export function decisionsClass(item: DecisionItem, answer: DecisionAnswer): DecisionsClass | null {
  if (item.door === "one-way") return "one-way";
  const picked = answer.optionId !== undefined || answer.optionIds !== undefined;
  if (item.kind === "decide" && (item.options?.length ?? 0) >= 2 && picked) return "a-b";
  if (item.class !== undefined || item.category === "policy") return "policy";
  return null;
}

function pickedLabels(item: DecisionItem, answer: DecisionAnswer): string[] {
  const ids = answer.optionIds ?? (answer.optionId === undefined ? [] : [answer.optionId]);
  return ids.map((id) => item.options?.find((option) => option.id === id)?.label ?? id);
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const oneLine = (text: string): string => text.replace(CONTROL, " ");

/** One unnumbered bullet, so it never collides with the numbered items written by hand. */
export function decisionLine(item: DecisionItem, answer: DecisionAnswer): string {
  const picks = pickedLabels(item, answer);
  const pick = picks.length > 0 ? picks.join(", ") : (answer.text ?? "(no pick)");
  const note = picks.length > 0 && answer.text !== undefined ? `; "${answer.text}"` : "";
  const time = new Date(answer.at).toISOString().slice(11, 16);
  const raw = `- ${time}Z ${decisionsClass(item, answer) ?? "answer"}: ${item.summary} → ${pick}${note} (item ${item.id}, by ${answer.by.id} via ${answer.by.channel})`;
  const line = oneLine(raw);
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/** A round answer keys by round and question, so the same answer reached through the queue keys the same. */
function ledgerKey(item: DecisionItem, answer: DecisionAnswer): string {
  const [only] = item.sources;
  if (item.sources.length === 1 && only?.system === "round") return `round:${only.ref.replace("#", ":")}:${answer.at}`;
  return `queue:${item.id}:${answer.at}`;
}

function ledgerAnswer(item: DecisionItem, answer: DecisionAnswer): string | null {
  const picks = pickedLabels(item, answer);
  if (picks.length > 0) return picks.join(", ");
  return answer.text ?? (answer.changeRequested ? "changes requested" : null);
}

function ledgerRow(item: DecisionItem, answer: DecisionAnswer, file: string) {
  const options = (item.options ?? []).map(({ label, description }) => (description === undefined ? { label } : { label, description }));
  const recommendedId = item.recommended?.optionId;
  const wire: LedgerRowWire = {
    v: 2,
    source: "queue",
    key: ledgerKey(item, answer),
    asked_at: item.openedAt ?? null,
    answered_at: answer.at,
    locator: { path: file },
    initiative: item.initiative ?? null,
    category: item.category,
    header: item.category ?? null,
    question: item.summary,
    options,
    recommended: item.options?.find((option) => option.id === recommendedId)?.label ?? null,
    answer: ledgerAnswer(item, answer),
    free_text: answer.text ?? null,
    answered_by: "owner-remote",
    route: item.route?.target ?? null,
  };
  const extras = { item: { id: item.id, sources: item.sources, kind: item.kind, door: item.door, keys: item.keys }, by: answer.by, decisions: decisionsClass(item, answer) };
  return { wire, extras };
}

async function exclusionReason(item: DecisionItem, answer: DecisionAnswer, humanOnly: DecisionLogOptions["humanOnly"]): Promise<Reason | null> {
  if (item.personal) return "personal";
  const known = await humanOnly().catch((): HumanOnly => ({ known: false }));
  if (!known.known) return "human-only unknown";
  const options = (item.options ?? []).map(({ label }) => ({ label }));
  const subject = { initiative: item.initiative ?? null, header: item.category ?? null, question: item.summary, options, answer: ledgerAnswer(item, answer) };
  const verdict = isExcluded(subject, { humanOnlyInitiatives: [...known.initiatives], projectInitiatives: [], personalDataPatterns: [] });
  if (!verdict.excluded) return null;
  return verdict.reason === "human-only-initiative" ? "human-only-initiative" : "personal";
}

async function withHandle(file: string, flags: number, mode: number | undefined, write: (handle: FileHandle) => Promise<void>): Promise<void> {
  const handle = await open(file, flags, mode);
  try {
    await write(handle);
  } finally {
    await handle.close();
  }
}

/** The fstat checks run on the opened file, so a swap after open cannot redirect the write. */
async function appendLedger(file: string, row: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withHandle(file, LEDGER_FLAGS, 0o600, async (handle) => {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
      throw new Error("answers.jsonl is not a private regular file owned by this user");
    }
    await handle.write(`${JSON.stringify(row)}\n`);
  });
}

async function readTail(handle: FileHandle, size: number): Promise<string> {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, size - length);
  return buffer.toString("utf8");
}

/** Only today's heading as the last `## ` line takes a bare bullet; anything else gets a new heading. */
function decisionsAppend(tail: string, date: string, bullet: string): string {
  const heading = `## Queue answers ${date}`;
  const lastHeading = tail.split("\n").filter((line) => line.startsWith("## ")).at(-1)?.trimEnd();
  const lead = tail === "" || tail.endsWith("\n") ? "" : "\n";
  return lastHeading === heading ? `${lead}${bullet}\n` : `${lead}\n${heading}\n\n${bullet}\n`;
}

async function appendDecision(file: string, date: string, bullet: string): Promise<void> {
  await withHandle(file, DECISIONS_FLAGS, undefined, async (handle) => {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("the decisions file is not a regular file");
    await handle.write(decisionsAppend(await readTail(handle, stats.size), date, bullet));
  });
}

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

const localDate = (at: string): string => {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** One write at a time, so two answers in the same second cannot both add a heading. */
function serializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

interface Writer {
  ledgerFile: string;
  decisionsFile: string | null;
  today: (at: string) => string;
  logger?: LogLogger;
}

async function attempt(writer: Writer, reason: Reason, write: () => Promise<void>): Promise<Reason | null> {
  try {
    await write();
    return null;
  } catch (error) {
    writer.logger?.warn({ error }, `decision log: ${reason}`);
    return reason === "decisions write failed" && errnoOf(error) === "ENOENT" ? "decisions file missing" : reason;
  }
}

async function writeLedger(writer: Writer, item: DecisionItem, answer: DecisionAnswer): Promise<Reason | null> {
  return attempt(writer, "ledger write failed", async () => {
    const { wire, extras } = ledgerRow(item, answer, writer.ledgerFile);
    LedgerRowSchema.parse(wire);
    await appendLedger(writer.ledgerFile, { ...wire, ...extras });
  });
}

async function writeAnswer(writer: Writer, item: DecisionItem, answer: DecisionAnswer): Promise<DecisionLogResult> {
  const ledgerFailure = await writeLedger(writer, item, answer);
  const ledger = ledgerFailure === null ? "written" : "failed";
  if (decisionsClass(item, answer) === null) return withReason({ ledger, decisions: "not-a-decision" }, ledgerFailure);
  const file = writer.decisionsFile;
  if (file === null) return withReason({ ledger, decisions: "not-configured" }, ledgerFailure);
  const decisionsFailure = await attempt(writer, "decisions write failed", () => appendDecision(file, writer.today(answer.at), decisionLine(item, answer)));
  return withReason({ ledger, decisions: decisionsFailure === null ? "written" : "failed" }, ledgerFailure ?? decisionsFailure);
}

function withReason(result: Omit<DecisionLogResult, "reason">, reason: Reason | null): DecisionLogResult {
  return reason === null ? result : { ...result, reason };
}

export function createDecisionLog({ stateDir, decisionsFile, humanOnly, today = localDate, logger }: DecisionLogOptions): DecisionLog {
  const writer: Writer = { ledgerFile: path.join(stateDir, ANSWERS_FILE), decisionsFile, today, ...(logger ? { logger } : {}) };
  const serialize = serializer();
  const record = async (item: DecisionItem, answer: DecisionAnswer): Promise<DecisionLogResult> => {
    const excluded = await exclusionReason(item, answer, humanOnly).catch((): Reason => "human-only unknown");
    if (excluded !== null) return { ledger: "excluded", decisions: "excluded", reason: excluded };
    return serialize(() => writeAnswer(writer, item, answer)).catch((error: unknown) => {
      logger?.warn({ error }, "decision log: record failed");
      return { ledger: "failed" as const, decisions: "failed" as const, reason: "ledger write failed" as const };
    });
  };
  return { record };
}
