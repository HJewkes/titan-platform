/**
 * Follow-up answers (TP-3346). A side answer on a Ship round that the owner marks follow-up is not this PR's to
 * fix: it never blocks Ship (`ship-blockers.ts`) and is filed for later instead. The strict feedback@1 schema has
 * no field for the mark, so the question ids go to a `follow-ups.json` sidecar beside the feedback, as Addressed
 * ticks go to `addressed.json`, and a later round of the unit reads it so the answer never comes back as open
 * feedback. Each follow-up is also filed into the console's own owner-inbox spool as a planning item with the
 * answer text and the round and PR, the same `writeDeposit` path the console's update alarm takes. This module
 * must not import `rounds.ts`, which reads the sidecar through it.
 */
import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import type { Manifest, Question } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";

export const FOLLOW_UPS_FILE = "follow-ups.json";
const FOLLOW_UPS_SCHEMA_ID = "titan-console/follow-ups@1";
const FOLLOW_UP_ASKER = "titan-console";
const FOLLOW_UP_KEY = "round-follow-up";
const MAX_FOLLOW_UPS_BYTES = 64 * 1024;
const SUMMARY_MAX = 280;
const CONTEXT_MAX = 4000;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const sidecar = z.object({ schema: z.literal(FOLLOW_UPS_SCHEMA_ID), questionIds: z.array(z.string()), at: z.string() });

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function followUpsBytes(questionIds: readonly string[], now: Date): Buffer {
  return Buffer.from(`${JSON.stringify({ schema: FOLLOW_UPS_SCHEMA_ID, questionIds, at: now.toISOString() }, null, 2)}\n`);
}

const fitsCap = (stats: Stats): boolean => stats.isFile() && stats.size <= MAX_FOLLOW_UPS_BYTES;

async function readText(file: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    return fitsCap(await handle.stat()) ? await handle.readFile("utf8") : undefined;
  } finally {
    await handle.close();
  }
}

/** The question ids a round filed as follow-ups; empty for every way the sidecar can be missing or wrong. */
export async function readFollowUps(roundDir: string): Promise<string[]> {
  try {
    const text = await readText(path.join(roundDir, FOLLOW_UPS_FILE));
    const parsed = text === undefined ? undefined : sidecar.safeParse(JSON.parse(text));
    return parsed?.success ? parsed.data.questionIds : [];
  } catch {
    return [];
  }
}

function answerText(answer: SubmittedAnswer): string | undefined {
  if (answer.revisionRequested) return "Request a revision";
  if (answer.pick !== undefined) return answer.pick;
  if (answer.picks !== undefined) return answer.picks.join(", ");
  if (answer.value !== undefined) return String(answer.value);
  return answer.text?.trim() || undefined;
}

function answerLines(answer: SubmittedAnswer): string[] {
  const given = answerText(answer);
  return [
    ...(given === undefined ? [] : [`Answer: ${given}`]),
    ...(answer.comment?.trim() ? [`Comment: ${answer.comment.trim()}`] : []),
    ...(answer.optionNotes ?? []).map((each) => `Note on ${each.option}: ${each.note}`),
  ];
}

const mergeOf = (manifest: Manifest) => manifest.questions.flatMap((question) => (question.kind === "pick-one" && question.merge ? [question.merge] : []))[0];

/** One owner-inbox planning item for one follow-up answer; keyed on the round and question, so a retry files nothing new. */
export function followUpDeposit(roundId: string, manifest: Manifest, question: Question, answer: SubmittedAnswer): OwnerItemDeposit {
  const merge = mergeOf(manifest);
  const where = merge === undefined ? `${manifest.unit} round ${manifest.round}` : `${merge.repo}#${merge.pr}`;
  const lead = `Marked follow-up on ${manifest.unit} round ${manifest.round} (round ${roundId}): not a change for ${where}.`;
  return {
    depositId: `${FOLLOW_UP_KEY}-${roundId}-${digest(question.id)}`,
    asker: FOLLOW_UP_ASKER,
    kind: "review",
    door: "two-way",
    summary: clip(oneLine(`Follow-up from ${where}: ${question.prompt}`), SUMMARY_MAX),
    context: clip([lead, `Question: ${question.prompt}`, ...answerLines(answer)].join("\n"), CONTEXT_MAX),
    ...(merge !== undefined && { shown: [`https://github.com/${merge.repo}/pull/${merge.pr}`] }),
    keys: [FOLLOW_UP_KEY],
  };
}
