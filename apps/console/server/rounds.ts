/**
 * The review rounds the owner answers in the console: one `<round-id>/round.json` per directory
 * under the rounds dir, validated with review-schema's `RoundSchema`. This module only reads.
 *
 * Another process writes the dir, so every read is defended: a round id is a plain name (no
 * dot, no slash), a round directory or file that is a symlink is refused, `round.json` is read
 * through `O_NOFOLLOW` up to a size cap, and no path a manifest names (an image, a frame) is
 * ever opened. A round is `sent` once a `feedback.json` sits beside it.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RoundSchema, isLoopbackUrl, type Manifest, type Question } from "@titan-design/review-schema";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";

export interface RoundsSource {
  dir: string;
}

export const MAX_ROUND_BYTES = 1024 * 1024;
/** The list stops here, so a dir full of junk cannot make one read unbounded. */
const MAX_ROUNDS = 500;
const ROUND_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROUND_FILE = "round.json";
const FEEDBACK_FILE = "feedback.json";
const MAX_REASON_ISSUES = 5;

const roundStatus = z.enum(["open", "sent"]);
type RoundStatus = z.infer<typeof roundStatus>;

const roundHead = { id: z.string(), status: roundStatus, updatedAt: z.string().nullable() };
const invalidRound = z.object({ ...roundHead, valid: z.literal(false), reason: z.string() });

const roundSummary = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    unit: z.string(),
    round: z.number(),
    questions: z.number(),
    design: z.boolean(),
    recommendations: z.enum(["after-answer", "shown"]),
  }),
  invalidRound,
]);

const roundDetail = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    /** A round with frames is a design round; the console renders questions only, so it points to the harness. */
    design: z.boolean(),
    /** True while an after-answer round is unsent: every question's recommendation is stripped. */
    recommendationsWithheld: z.boolean(),
    /** Null unless the manifest's Storybook host is loopback. */
    storybookUrl: z.string().nullable(),
    manifest: z.custom<Manifest>(),
  }),
  invalidRound,
]);

export type RoundSummary = z.infer<typeof roundSummary>;
export type RoundDetail = z.infer<typeof roundDetail>;

type Parsed = { ok: true; manifest: Manifest } | { ok: false; reason: string };

interface LoadedRound {
  id: string;
  status: RoundStatus;
  updatedAt: string | null;
  parsed: Parsed;
}

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

function schemaReason(error: z.ZodError): string {
  const issues = error.issues.slice(0, MAX_REASON_ISSUES).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const more = error.issues.length - issues.length;
  return more > 0 ? `${issues.join("; ")}; and ${more} more` : issues.join("; ");
}

function parseManifest(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${ROUND_FILE} is not JSON` };
  }
  const result = RoundSchema.safeParse(json);
  return result.success ? { ok: true, manifest: result.data } : { ok: false, reason: schemaReason(result.error) };
}

/** Reads at most one byte past the cap, so a file that grew after its fstat is still refused. */
async function readCapped(handle: FileHandle): Promise<string | null> {
  const buffer = Buffer.alloc(MAX_ROUND_BYTES + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
    if (filled > MAX_ROUND_BYTES) return null;
  }
  return buffer.toString("utf8", 0, filled);
}

function unreadableReason(error: unknown): string {
  const code = errnoOf(error);
  if (code === "ENOENT") return `no ${ROUND_FILE}`;
  if (code === "ELOOP") return `${ROUND_FILE} is a symlink`;
  return `${ROUND_FILE} could not be read`;
}

async function readManifest(roundDir: string): Promise<{ parsed: Parsed; updatedAt: string | null }> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ROUND_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { parsed: { ok: false, reason: unreadableReason(error) }, updatedAt: null };
  }
  try {
    const stats = await handle.stat();
    const updatedAt = stats.mtime.toISOString();
    if (!stats.isFile()) return { parsed: { ok: false, reason: `${ROUND_FILE} is not a regular file` }, updatedAt };
    const tooBig = { ok: false as const, reason: `${ROUND_FILE} is over ${MAX_ROUND_BYTES} bytes` };
    if (stats.size > MAX_ROUND_BYTES) return { parsed: tooBig, updatedAt };
    const text = await readCapped(handle);
    return { parsed: text === null ? tooBig : parseManifest(text), updatedAt };
  } finally {
    await handle.close();
  }
}

/** Only a regular `feedback.json` marks a round sent; a symlink there proves nothing. */
async function statusOf(roundDir: string): Promise<RoundStatus> {
  const stats = await lstat(path.join(roundDir, FEEDBACK_FILE)).catch(() => null);
  return stats?.isFile() ? "sent" : "open";
}

async function loadRound(dir: string, id: string): Promise<LoadedRound> {
  const roundDir = path.join(dir, id);
  const [{ parsed, updatedAt }, status] = await Promise.all([readManifest(roundDir), statusOf(roundDir)]);
  return { id, status, updatedAt, parsed };
}

/** False for a bad id, a missing entry, or anything that is not a real directory, a symlink included. */
async function roundDirExists(dir: string, id: string): Promise<boolean> {
  if (!ROUND_ID.test(id)) return false;
  const stats = await lstat(path.join(dir, id)).catch(() => null);
  return stats?.isDirectory() ?? false;
}

function summaryOf({ id, status, updatedAt, parsed }: LoadedRound): RoundSummary {
  if (!parsed.ok) return { id, status, updatedAt, valid: false, reason: parsed.reason };
  const { manifest } = parsed;
  return {
    id, status, updatedAt, valid: true, unit: manifest.unit, round: manifest.round,
    questions: manifest.questions.length, design: manifest.variants.length > 0, recommendations: manifest.recommendations,
  };
}

function withoutRecommendation(question: Question): Question {
  if (!("recommendation" in question)) return question;
  const stripped = { ...question };
  delete stripped.recommendation;
  return stripped;
}

function detailOf({ id, status, updatedAt, parsed }: LoadedRound): RoundDetail {
  if (!parsed.ok) return { id, status, updatedAt, valid: false, reason: parsed.reason };
  const withheld = parsed.manifest.recommendations === "after-answer" && status === "open";
  const manifest = withheld ? { ...parsed.manifest, questions: parsed.manifest.questions.map(withoutRecommendation) } : parsed.manifest;
  return {
    id, status, updatedAt, valid: true, design: manifest.variants.length > 0, recommendationsWithheld: withheld,
    storybookUrl: isLoopbackUrl(manifest.storybookUrl) ? manifest.storybookUrl : null, manifest,
  };
}

const newestFirst = (a: RoundSummary, b: RoundSummary): number => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id);

/** A missing rounds dir is no rounds yet; a symlinked round directory is skipped, as `isDirectory` is false for it. */
export async function listRounds({ dir }: RoundsSource): Promise<{ rounds: RoundSummary[]; truncated: boolean }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoOf(error) === "ENOENT") return [];
    throw failure("the rounds dir could not be read", EXIT.UNAVAILABLE);
  });
  const ids = entries.filter((entry) => entry.isDirectory() && ROUND_ID.test(entry.name)).map((entry) => entry.name).sort();
  const loaded = await Promise.all(ids.slice(0, MAX_ROUNDS).map((id) => loadRound(dir, id)));
  return { rounds: loaded.map(summaryOf).sort(newestFirst), truncated: ids.length > MAX_ROUNDS };
}

export async function getRound({ dir }: RoundsSource, id: string): Promise<RoundDetail> {
  if (!(await roundDirExists(dir, id))) throw failure(`No round named "${id}"`, EXIT.NOINPUT);
  return detailOf(await loadRound(dir, id));
}

export function roundsCommands(source: RoundsSource) {
  return {
    "rounds.list": readCommand({
      name: "rounds.list",
      description: "Every review round in the rounds dir, newest first: open or sent, and the schema's reason for any invalid one",
      args: z.object({}),
      result: z.object({ rounds: z.array(roundSummary), truncated: z.boolean() }),
      run: () => listRounds(source),
    }),
    "rounds.get": readCommand({
      name: "rounds.get",
      description: "One review round's manifest; an unsent after-answer round comes without its recommendations",
      args: z.object({ id: z.string().min(1).max(64) }),
      result: roundDetail,
      run: ({ id }) => getRound(source, id),
    }),
  };
}
