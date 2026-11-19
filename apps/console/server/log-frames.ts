/**
 * Before and after frames on the #/log page's visual ship rows (TP-6777). Shepherd's `log-frames` verb reads the PR's
 * pr-visual artifact through pr-visual-round.ts and writes its changed pairs into `<state>/log-frames/<owner>/<repo>/<pr>/`.
 * The console then writes `frames.json` (titan-review/frames@1) beside them, once: a later build finds it and does nothing,
 * so the row keeps its frames after the artifact expires. A read that failed writes nothing and is tried on a later build.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { FramesIndexSchema, readFrameBytes } from "./round-frames.js";

const FRAMES_FILE = "frames.json";
const NAME_PART = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const AFTER_SUFFIX = "-after.png";

/** What Shepherd's `log-frames` verb reports: the written files as before, after pairs in order, or why there are none. */
export interface Captured {
  line: string;
  variantKeys: string[];
  reason?: string;
  failed?: true;
}

export interface CaptureTarget {
  repo: string;
  pr: number;
  head: string;
  dir: string;
}

export type FramesCapture = (target: CaptureTarget) => Promise<Captured | { error: string }>;

/** A row's frames: each changed shot by key and label, or the one line that says why the row has none. */
export interface LogFrames {
  repo: string;
  pr: number;
  pairs: { key: string; label: string }[];
  note?: string;
}

const frameRecord = FramesIndexSchema.shape.frames.element;
const LogFramesIndexSchema = FramesIndexSchema.extend({
  frames: z.array(frameRecord.extend({ label: z.string(), base: frameRecord.shape.base.unwrap() })),
  evidence: z.string(),
  reason: z.string().optional(),
});
type LogFramesIndex = z.infer<typeof LogFramesIndexSchema>;

export function isSafeRepo(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => NAME_PART.test(part));
}

/** GitHub names are case-insensitive, so the folder is too: a row and its `log.frame` read meet whatever case each used. */
export function framesDirOf(stateDir: string, repo: string, pr: number): string {
  if (!isSafeRepo(repo)) throw failure("log frames: the repo is not owner/repo", EXIT.USAGE);
  return path.join(stateDir, "log-frames", ...repo.toLowerCase().split("/"), String(pr));
}

async function readIndex(folder: string): Promise<LogFramesIndex | null> {
  const text = await readFile(path.join(folder, FRAMES_FILE), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  const parsed = LogFramesIndexSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw failure("log frames: frames.json is not a log frames@1 index", EXIT.DATAERR);
  return parsed.data;
}

/** The PR's frames, or null when none were captured yet. */
export async function readLogFrames(stateDir: string, repo: string, pr: number): Promise<LogFrames | null> {
  const index = await readIndex(framesDirOf(stateDir, repo, pr));
  if (index === null) return null;
  const pairs = index.frames.map(({ key, label }) => ({ key, label }));
  return pairs.length > 0 ? { repo, pr, pairs } : { repo, pr, pairs, note: `no visual evidence: ${index.reason ?? "no shot changed"}` };
}

/** Shepherd names an after file `<index>-<story>@<width>-after.png`; the label is the story at its width. */
const labelOf = (afterName: string): string => afterName.slice(0, -AFTER_SUFFIX.length).replace(/^\d+-/, "");

/** Shepherd lists each changed shot's before then its after, both inside the folder it was given. */
function pairsOf(folder: string, files: readonly string[]): { before: string; after: string }[] {
  const relative = files.map((file) => path.relative(folder, file));
  const pairs = relative.flatMap((before, at) => (at % 2 === 0 ? [{ before, after: relative[at + 1] ?? "" }] : []));
  if (pairs.some(({ after }) => !after.endsWith(AFTER_SUFFIX))) throw failure("log frames: Shepherd wrote an unexpected pair", EXIT.DATAERR);
  return pairs;
}

async function indexOf(folder: string, captured: Captured): Promise<LogFramesIndex> {
  const frames: LogFramesIndex["frames"] = [];
  for (const { before, after } of pairsOf(folder, captured.variantKeys)) {
    const [base, head] = [await readFrameBytes(folder, before), await readFrameBytes(folder, after)];
    frames.push({ key: `shot-${frames.length}`, label: labelOf(after), file: after, sha256: head.sha256, base: { file: before, sha256: base.sha256 } });
  }
  const reason = frames.length === 0 ? captured.reason : undefined;
  return { schema: "titan-review/frames@1", frames, evidence: captured.line, ...(reason !== undefined && { reason }) };
}

async function writeIndex(folder: string, index: LogFramesIndex): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const staged = path.join(folder, `.${FRAMES_FILE}.${randomUUID()}`);
  await writeFile(staged, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  await rename(staged, path.join(folder, FRAMES_FILE));
}

export type CaptureOutcome = "kept" | "written" | { skipped: string };

/** Writes the PR's frames.json once; a folder that already has one is left alone, and a failed read writes nothing. */
export async function captureLogFrames(target: Omit<CaptureTarget, "dir">, stateDir: string, capture: FramesCapture): Promise<CaptureOutcome> {
  const dir = framesDirOf(stateDir, target.repo, target.pr);
  if ((await readIndex(dir)) !== null) return "kept";
  const captured = await capture({ ...target, dir });
  if ("error" in captured) return { skipped: captured.error };
  if (captured.failed) return { skipped: captured.reason ?? captured.line };
  await writeIndex(dir, await indexOf(dir, captured));
  return "written";
}

const FRAME_SIDES = ["before", "after"] as const;
export type FrameSide = (typeof FRAME_SIDES)[number];
export const frameSideSchema = z.enum(FRAME_SIDES);

/** One side of one pair, checked against the sha256 frames.json recorded for it. */
export async function readLogFrame(stateDir: string, repo: string, pr: number, key: string, side: FrameSide) {
  const folder = framesDirOf(stateDir, repo, pr);
  const record = (await readIndex(folder))?.frames.find((frame) => frame.key === key);
  if (record === undefined) throw failure(`log frames: ${repo}#${pr} has no frame "${key}"`, EXIT.NOINPUT);
  const listed = side === "after" ? { file: record.file, sha256: record.sha256 } : record.base;
  const { bytes, sha256 } = await readFrameBytes(folder, listed.file, listed.sha256);
  return { contentType: "image/png" as const, bytes: bytes.length, sha256, base64: bytes.toString("base64") };
}
