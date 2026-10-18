/**
 * The owner's notes on a rendered video: timestamped comments and Ship / Needs changes verdicts,
 * one `titan-console/video-note@1` JSON line each, in `<name>.notes.jsonl` beside the video. The
 * sidecar is the store of record, so the next video agent reads it in place.
 *
 * Every note names the sha256 of the render it was made on. Re-rendering the video changes that
 * sha, so its earlier notes read back as `current: false`, and `openNotes` is the one place the
 * agent pickup rule is written. Appends open with O_APPEND and write one line of at most 4 KB in
 * one `write`, so two appends never interleave or truncate each other. The sidecar opens with
 * O_NOFOLLOW, so a symlink planted at its name is refused rather than written through.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ownerWriteCommand, readCommand } from "./owner-guard.js";
import { OPEN_FLAGS, readCapped } from "./rounds.js";
import { locateVideo, verdict, videoCatalog, type NoteSummarizer, type VideoCatalog } from "./videos.js";

export const VIDEO_NOTE_SCHEMA = "titan-console/video-note@1";
export const MAX_NOTE_TEXT = 2000;
const MAX_NOTE_LINE_BYTES = 4096;
const MAX_NOTES_BYTES = 1024 * 1024;
const MAX_CACHED_SHAS = 4096;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Fixed so a refusal never tells the client whether, or where, a file exists. */
const NOT_FOUND = "Video not found";

const noteHead = {
  schema: z.literal(VIDEO_NOTE_SCHEMA),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  videoId: z.string(),
  /** The video's file name only, never a path. */
  video: z.string().min(1),
  renderSha256: z.string().regex(/^[0-9a-f]{64}$/),
  atS: z.number().min(0),
  createdAt: z.iso.datetime(),
};

const commentNote = z.strictObject({ ...noteHead, kind: z.literal("comment"), text: z.string().min(1).max(MAX_NOTE_TEXT) });
const verdictNote = z.strictObject({ ...noteHead, kind: z.literal("verdict"), verdict });

const videoNote = z.discriminatedUnion("kind", [commentNote, verdictNote]);

export type VideoNote = z.infer<typeof videoNote>;
type Verdict = z.infer<typeof verdict>;

/** `current`: made on the render now on disk. */
const isCurrent = { current: z.boolean() };
const readNote = z.discriminatedUnion("kind", [commentNote.extend(isCurrent), verdictNote.extend(isCurrent)]);
type ReadNote = z.infer<typeof readNote>;

const noteArgs = z.strictObject({
  videoId: z.string(),
  atS: z.number().min(0),
  kind: z.enum(["comment", "verdict"]),
  text: z.string().trim().min(1).max(MAX_NOTE_TEXT).optional(),
  verdict: verdict.optional(),
});

type NoteInput = Omit<z.infer<typeof noteArgs>, "videoId">;

interface NotesRead {
  notes: ReadNote[];
  verdict: Verdict | null;
  /** Unparsable lines, skipped so one bad line never hides the rest. */
  skipped: number;
  gaps: string[];
}

const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

export function notesFileOf(videoFile: string): string {
  return path.join(path.dirname(videoFile), `${path.parse(videoFile).name}.notes.jsonl`);
}

/** Keyed by what identifies the bytes, not the path: a render rewritten in place must hash again. */
const shaCache = new Map<string, string>();

export async function renderSha256(videoFile: string): Promise<string> {
  const handle = await open(videoFile, OPEN_FLAGS);
  try {
    const info = await handle.stat();
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const cached = shaCache.get(key);
    if (cached !== undefined) return cached;
    const hash = createHash("sha256");
    const chunks: AsyncIterable<Buffer> = handle.createReadStream({ autoClose: false });
    for await (const chunk of chunks) hash.update(chunk);
    return remember(key, hash.digest("hex"));
  } finally {
    await handle.close();
  }
}

function remember(key: string, sha: string): string {
  if (shaCache.size >= MAX_CACHED_SHAS) shaCache.delete(shaCache.keys().next().value!);
  shaCache.set(key, sha);
  return sha;
}

/** A comment carries text and no verdict; a verdict carries a verdict and no text. */
function noteBody(input: NoteInput): { kind: "comment"; text: string } | { kind: "verdict"; verdict: Verdict } {
  if (input.kind === "comment") {
    if (input.verdict !== undefined || input.text === undefined) return refuse("a comment carries text and no verdict");
    return { kind: "comment", text: input.text };
  }
  if (input.text !== undefined || input.verdict === undefined) return refuse("a verdict carries a verdict and no text");
  return { kind: "verdict", verdict: input.verdict };
}

export async function appendNote(videoFile: string, videoId: string, input: NoteInput, now = new Date()): Promise<VideoNote> {
  const note = videoNote.parse({
    schema: VIDEO_NOTE_SCHEMA,
    id: randomBytes(8).toString("hex"),
    videoId,
    video: path.basename(videoFile),
    renderSha256: await renderSha256(videoFile),
    atS: Math.round(input.atS * 1000) / 1000,
    createdAt: now.toISOString(),
    ...noteBody(input),
  });
  const line = Buffer.from(`${JSON.stringify(note)}\n`);
  if (line.length > MAX_NOTE_LINE_BYTES) refuse(`the note is over ${MAX_NOTE_LINE_BYTES} bytes once encoded`);
  await appendLine(notesFileOf(videoFile), line);
  return note;
}

async function appendLine(file: string, line: Buffer): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(file, APPEND_FLAGS, 0o600);
  } catch {
    throw failure("the notes file could not be opened", EXIT.UNAVAILABLE);
  }
  try {
    if (!(await handle.stat()).isFile()) refuse("the notes file is not a regular file");
    const { bytesWritten } = await handle.write(line);
    if (bytesWritten !== line.length) throw failure("the notes file took a partial write", EXIT.UNAVAILABLE);
  } finally {
    await handle.close();
  }
}

async function readSidecar(file: string): Promise<{ bytes: Buffer | null; gap: string | null }> {
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    return { bytes: null, gap: errnoOf(error) === "ENOENT" ? null : "the notes file could not be read" };
  }
  try {
    if (!(await handle.stat()).isFile()) return { bytes: null, gap: "the notes file is not a regular file" };
    const bytes = await readCapped(handle, MAX_NOTES_BYTES);
    return bytes === null ? { bytes: null, gap: `the notes file is over ${MAX_NOTES_BYTES} bytes and was not read` } : { bytes, gap: null };
  } finally {
    await handle.close();
  }
}

/** Keeps only notes on this file name: `cut.mp4` and `cut.webm` share one sidecar. */
function parseNotes(bytes: Buffer, video: string): { notes: VideoNote[]; skipped: number } {
  const notes: VideoNote[] = [];
  let skipped = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = videoNote.safeParse(parseJson(line));
    if (!parsed.success) skipped++;
    else if (parsed.data.video === video) notes.push(parsed.data);
  }
  return { notes, skipped };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Hashes the video only when it has notes, so listing renders nobody has commented on stays cheap. */
export async function readNotes(videoFile: string): Promise<NotesRead> {
  const { bytes, gap } = await readSidecar(notesFileOf(videoFile));
  const { notes, skipped } = bytes === null ? { notes: [], skipped: 0 } : parseNotes(bytes, path.basename(videoFile));
  const gaps = [...(gap === null ? [] : [gap]), ...(skipped > 0 ? [`${skipped} unreadable note line${skipped === 1 ? "" : "s"} skipped`] : [])];
  if (notes.length === 0) return { notes: [], verdict: null, skipped, gaps };
  const currentSha = await renderSha256(videoFile);
  return { notes: notes.map((note) => ({ ...note, current: note.renderSha256 === currentSha })), verdict: currentVerdict(notes, currentSha), skipped, gaps };
}

/** The latest verdict made on this render; one on an earlier render says nothing about this one. */
export function currentVerdict(notes: readonly VideoNote[], currentSha: string): Verdict | null {
  const verdicts = notes.filter((note) => note.kind === "verdict" && note.renderSha256 === currentSha);
  const latest = verdicts.at(-1);
  return latest?.kind === "verdict" ? latest.verdict : null;
}

/**
 * The agent pickup rule: comments on the current render made after its latest Ship, in the order
 * they were written. A Ship on an earlier render closes nothing, and re-rendering leaves every
 * earlier note behind as history.
 */
export function openNotes<Note extends VideoNote>(notes: readonly Note[], currentSha: string): Note[] {
  const current = notes.filter((note) => note.renderSha256 === currentSha);
  const afterShip = current.reduce((start, note, index) => (note.kind === "verdict" && note.verdict === "ship" ? index + 1 : start), 0);
  return current.slice(afterShip).filter((note) => note.kind === "comment");
}

export const summarizeNotes: NoteSummarizer = async (videoFile) => {
  const { notes, verdict: latest } = await readNotes(videoFile);
  return { noteCount: notes.filter((note) => note.current && note.kind === "comment").length, verdict: latest };
};

async function locate(catalog: VideoCatalog, id: string): Promise<string> {
  const file = await locateVideo(catalog, id);
  if (file === null) throw failure(NOT_FOUND, EXIT.NOINPUT);
  return file;
}

export function videoNotesCommands(catalog: VideoCatalog = videoCatalog({ roots: [] })) {
  return {
    "videos.notes": readCommand({
      name: "videos.notes",
      description: "The owner's timestamped comments and verdicts on one video, each marked current when made on the render now on disk",
      args: z.object({ videoId: z.string() }),
      result: z.object({ video: z.string(), notes: z.array(readNote), verdict: verdict.nullable(), gaps: z.array(z.string()) }),
      run: async ({ videoId }) => {
        const file = await locate(catalog, videoId);
        const { notes, verdict: latest, gaps } = await readNotes(file);
        return { video: path.basename(file), notes, verdict: latest, gaps };
      },
    }),
    "videos.note": ownerWriteCommand({
      name: "videos.note",
      description: "Append one owner comment or verdict, stamped with the playback time and the render's sha256, to the notes file beside a video",
      args: noteArgs,
      result: videoNote,
      ownerWrite: true,
      run: async ({ videoId, ...input }) => appendNote(await locate(catalog, videoId), videoId, input),
    }),
  };
}
