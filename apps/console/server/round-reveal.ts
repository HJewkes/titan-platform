/**
 * `rounds.reveal` (TP-3774, decision 513): the owner asks for one question's recommendation before answering a
 * round that holds them until answered. `rounds.get` keeps stripping every one; this command hands back only the
 * one asked for and records that the page was sent it, in a `revealed.json` sidecar, as the strict feedback@1 schema
 * has no field for a reveal. `rounds.submit` takes an answer's `recommendationSeen` only on a question recorded here,
 * so the page cannot tag an answer seen whose recommendation the server never sent.
 *
 * The request is bound to what the owner was shown, as a submit is: it names the round.json sha256 and is refused
 * when the file differs. Only an open after-answer round reveals; a sent or `shown` round already carries its
 * recommendations. The sidecar is rewritten whole through a fresh temp file and a rename, one write at a time, so
 * a reload reads either the old list or the new one.
 */
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ownerWriteCommand } from "./owner-guard.js";
import type { Manifest } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";
import { RecommendationSchema } from "./review-schema-0.3/index.js";
import { OPEN_FLAGS, readCapped, readManifest, roundDirExists, statusOf, type RoundsSource } from "./rounds.js";

export const REVEALED_FILE = "revealed.json";
const REVEALED_SCHEMA_ID = "titan-console/revealed@1";
const MAX_REVEALED_BYTES = 64 * 1024;

const reveal = z.object({ questionId: z.string(), at: z.string() });
const sidecar = z.object({ schema: z.literal(REVEALED_SCHEMA_ID), reveals: z.array(reveal) });
type Reveal = z.infer<typeof reveal>;

const revealArgs = z.strictObject({
  id: z.string().min(1).max(64),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  questionId: z.string().min(1),
});

const revealResult = z.object({
  recommendation: RecommendationSchema,
  /** False when an earlier reveal of this question is already on record. */
  recorded: z.boolean(),
});

const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

async function readReveals(roundDir: string): Promise<Reveal[]> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, REVEALED_FILE), OPEN_FLAGS);
  } catch {
    return [];
  }
  try {
    const stats = await handle.stat();
    const bytes = stats.isFile() && stats.size <= MAX_REVEALED_BYTES ? await readCapped(handle, MAX_REVEALED_BYTES) : null;
    const parsed = bytes === null ? null : sidecar.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed?.success ? parsed.data.reveals : [];
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

/** The questions whose recommendation the page was sent before the round was answered; none for a missing or broken sidecar. */
export async function revealedQuestionIds(roundDir: string): Promise<Set<string>> {
  return new Set((await readReveals(roundDir)).map((each) => each.questionId));
}

async function writeReveals(roundDir: string, reveals: readonly Reveal[]): Promise<void> {
  const file = path.join(roundDir, REVEALED_FILE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify({ schema: REVEALED_SCHEMA_ID, reveals }, null, 2)}\n`);
  try {
    const handle = await open(temp, "wx", 0o600);
    await handle.writeFile(bytes).finally(() => handle.close());
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true });
    throw failure(`${REVEALED_FILE} could not be written`, EXIT.UNAVAILABLE);
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** One read-append-write at a time, so two quick reveals cannot drop each other. */
function recordReveal(roundDir: string, questionId: string, now: Date): Promise<boolean> {
  const next = writes.then(async () => {
    const reveals = await readReveals(roundDir);
    if (reveals.some((each) => each.questionId === questionId)) return false;
    await writeReveals(roundDir, [...reveals, { questionId, at: now.toISOString() }]);
    return true;
  });
  writes = next.catch(() => undefined);
  return next;
}

function recommendationOf(manifest: Manifest, questionId: string) {
  const question = manifest.questions.find((each) => each.id === questionId) ?? refuse(`no question "${questionId}" in this round`);
  const recommendation = question.kind === "text" ? undefined : question.recommendation;
  return recommendation ?? refuse(`question "${questionId}" has no recommendation`);
}

type RevealArgs = z.infer<typeof revealArgs>;

export async function revealRecommendation({ dir }: RoundsSource, args: RevealArgs, now = new Date()): Promise<z.infer<typeof revealResult>> {
  if (!(await roundDirExists(dir, args.id))) throw failure(`No round named "${args.id}"`, EXIT.NOINPUT);
  const roundDir = path.join(dir, args.id);
  const status = await statusOf(roundDir);
  if (status !== "open") refuse(`refused: ${status}; only an open round reveals a recommendation`);
  const { parsed } = await readManifest(roundDir);
  if (!parsed.ok) return refuse(`round.json is not a valid round: ${parsed.reason}`);
  if (parsed.sha256 !== args.manifestSha256) refuse("round.json has changed since it was shown; reload the round");
  if (parsed.manifest.recommendations !== "after-answer") refuse("this round shows every recommendation already");
  const recommendation = recommendationOf(parsed.manifest, args.questionId);
  return { recommendation, recorded: await recordReveal(roundDir, args.questionId, now) };
}

const isSeen = (answer: SubmittedAnswer): boolean => answer.recommendationSeen === true;

/** An after-answer round's answer is tagged seen only where `rounds.reveal` recorded sending its recommendation. */
export async function refuseUnrevealedSeen(roundDir: string, manifest: Manifest, answers: readonly SubmittedAnswer[]): Promise<void> {
  const tagged = answers.filter(isSeen);
  if (tagged.length === 0 || manifest.recommendations === "shown") return;
  const revealed = await revealedQuestionIds(roundDir);
  const unrevealed = tagged.find((answer) => !revealed.has(answer.questionId));
  if (unrevealed) refuse(`question "${unrevealed.questionId}" is tagged recommendationSeen, but its recommendation was never revealed`);
}

export function roundsRevealCommands(source: RoundsSource) {
  return {
    "rounds.reveal": ownerWriteCommand({
      name: "rounds.reveal",
      description: "One question's withheld recommendation in an open after-answer round, recorded in revealed.json so the answer can be tagged seen",
      args: revealArgs,
      result: revealResult,
      ownerWrite: true,
      run: (args) => revealRecommendation(source, args),
    }),
  };
}
