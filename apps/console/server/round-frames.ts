/**
 * `rounds.frame`: one PNG a review round lists, for the console's Ship view. The client names a
 * frame key and a view, never a path. The path comes from the round itself: an image variant in
 * `round.json` (its head view), or a record in `frames/frames.json` (head, base, after and diff
 * files, theme and sha256). A CI packet's head file is its montage; `after` is the changed image alone.
 *
 * Another process writes the round dir, so the read is defended the way `rounds.ts` defends
 * `round.json`, and more: the path stays inside the round dir, every directory below the round dir
 * is lstat'd (O_NOFOLLOW guards the last component only), the open is O_NOFOLLOW and O_NONBLOCK, the
 * file is regular and under `MAX_FRAME_BYTES`, its first bytes are the PNG signature, and its sha256
 * matches the index whenever the index names one. Refusals carry fixed text and never a path.
 * `rounds.frameTargets` reads a record's element map the same way, always sha256-checked.
 */
import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { THEME_MODES } from "@titan-design/review-schema";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { OPEN_FLAGS, ROUND_ID, readCapped, readManifest, roundDirExists, type RoundsSource } from "./rounds.js";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const FRAMES_INDEX = path.join("frames", "frames.json");
export const FRAME_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** review-schema's `imagePath`: a relative .png path with no `..` segment. */
const IMAGE_PATH = /^(?![/\\]|[A-Za-z]:)(?!(.*[/\\])?\.\.([/\\]|$)).+\.[Pp][Nn][Gg]$/;
const TARGETS_PATH = /^(?![/\\]|[A-Za-z]:)(?!(.*[/\\])?\.\.([/\\]|$)).+\.json$/;
const MAX_TARGETS_BYTES = 256 * 1024;
const PNG_SIGNATURE =Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FRAME_VIEWS = ["head", "base", "after", "diff"] as const;
type FrameView = (typeof FRAME_VIEWS)[number];
type Theme = (typeof THEME_MODES)[number];

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const indexedFile = z.object({ file: z.string(), sha256: sha256Hex });

/**
 * frames@1 as review-harness writes it, plus the base, after and diff files a CI packet adds; other record fields are ignored.
 * `unit`, `round` and `manifestSha256` bind the index to its round.json; the reader here ignores them, the importer requires them.
 * `packet` and `prose` name a CI packet's JSON beside round.json, and `after` a record's after image; only the importer reads them.
 */
export const FramesIndexSchema = z.object({
  schema: z.literal("titan-review/frames@1"),
  unit: z.string().optional(),
  round: z.number().int().optional(),
  manifestSha256: sha256Hex.optional(),
  packet: indexedFile.optional(),
  prose: indexedFile.optional(),
  frames: z.array(
    z.object({
      key: z.string(),
      theme: z.enum(THEME_MODES).optional(),
      file: z.string(),
      sha256: sha256Hex,
      base: indexedFile.optional(),
      after: indexedFile.optional(),
      diff: indexedFile.optional(),
      /** The CSS px the harness shot the frame at; pins are measured in them. A malformed one is dropped, not refused. */
      viewport: z.object({ width: z.number().positive() }).optional().catch(undefined),
      /** The frame's element map, read by `rounds.frameTargets`. A malformed one is dropped: the frame's pins stay coordinates only. */
      targets: indexedFile.optional().catch(undefined),
    }),
  ),
});
type FramesIndex = z.infer<typeof FramesIndexSchema>;

/** One element the shooter found under the story root, in the viewport's CSS px from the frame's top left. */
const targetBox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  target: z.strictObject({ testId: z.string().optional(), role: z.string().optional(), text: z.string().optional() }),
});

const FrameTargetsSchema = z.object({ schema: z.literal("titan-review/frame-targets@1"), boxes: z.array(targetBox) });

interface FrameEntry {
  files: Partial<Record<FrameView, string>>;
  theme?: Theme;
  /** Listed in frames/frames.json, not only named by a variant's image. */
  indexed: boolean;
  /** frames.json gives the head and its base one sha256: main and head render the same. */
  unchanged: boolean;
  viewportWidth?: number;
  targets?: z.infer<typeof indexedFile>;
}

interface FrameIndex {
  /** False when the round has no frames/frames.json; an invalid one is refused before this is built. */
  present: boolean;
  entries: Map<string, FrameEntry>;
  /** Keyed by the file's path relative to the round dir, normalised, so `./a.png` and `a.png` share one sha. */
  sha256: Map<string, string>;
}

const frameResult = z.object({ contentType: z.literal("image/png"), bytes: z.number(), sha256: z.string(), base64: z.string() });
type FrameRead = z.infer<typeof frameResult>;

const framesResult = z.object({
  /** Whether the round has a frames/frames.json; a design round without one is answered in the harness. */
  indexed: z.boolean(),
  frames: z.array(
    z.object({
      key: z.string(),
      theme: z.enum(THEME_MODES).optional(),
      views: z.array(z.enum(FRAME_VIEWS)),
      indexed: z.boolean(),
      unchanged: z.boolean(),
      /** frames.json's viewport width, the CSS px a pin on the frame is measured in; absent when the record has none. */
      viewportWidth: z.number().optional(),
      /** True when the record names an element map, so pins on the frame can say what they sit on. */
      targets: z.literal(true).optional(),
    }),
  ),
});
type FramesList = z.infer<typeof framesResult>;

const targetsResult = z.object({ sha256: z.string(), boxes: z.array(targetBox) });
type TargetsRead = z.infer<typeof targetsResult>;

const refusal = (reason: string): Error => failure(`frame refused: ${reason}`, EXIT.NOINPUT);

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const canonical = (roundDir: string, rel: string): string => path.relative(roundDir, path.resolve(roundDir, rel));

/** Each directory between the round dir and the file must be a real directory, not a symlink. */
export async function assertRealDirs(roundDir: string, parts: readonly string[]): Promise<void> {
  let at = roundDir;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    const stats = await lstat(at).catch(() => null);
    if (!stats?.isDirectory()) throw refusal("a directory on its path is a symlink or missing");
  }
}

function openReason(error: unknown): string {
  const code = errnoOf(error);
  if (code === "ELOOP") return "the file is a symlink";
  if (code === "ENOENT") return "the round has no such file";
  return "the file could not be opened";
}

async function openInside(roundDir: string, rel: string): Promise<{ handle: FileHandle; full: string; parts: string[] }> {
  const full = path.resolve(roundDir, rel);
  if (!full.startsWith(roundDir + path.sep)) throw refusal("its path leaves the round");
  const parts = path.relative(roundDir, full).split(path.sep);
  await assertRealDirs(roundDir, parts);
  const handle = await open(full, OPEN_FLAGS).catch((error: unknown) => {
    throw refusal(openReason(error));
  });
  return { handle, full, parts };
}

/** The walk runs again after the open and the path must still name the opened file, which closes the swap-a-directory window. */
async function readInside(roundDir: string, rel: string, cap: number): Promise<Buffer> {
  const { handle, full, parts } = await openInside(roundDir, rel);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw refusal("not a regular file");
    if (stats.size > cap) throw refusal(`over ${cap} bytes`);
    await assertRealDirs(roundDir, parts);
    const now = await lstat(full).catch(() => null);
    if (now?.dev !== stats.dev || now.ino !== stats.ino) throw refusal("the file moved while it was opened");
    // Reading to the fstat size, not the cap, keeps a small frame's read small; a file that grew since is refused.
    const bytes = await readCapped(handle, stats.size);
    if (bytes === null) throw refusal("the file changed while it was read");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Any other file a round carries beside its frames, such as its Storybook sidecar, read with the same defences. */
export const readRoundBytes = (roundDir: string, rel: string, cap: number): Promise<Buffer> => readInside(path.resolve(roundDir), rel, cap);

/** A round without a frames index is fine; one with an unreadable or invalid index has no frame that can be trusted. */
async function readFramesIndex(roundDir: string): Promise<FramesIndex | null> {
  const present = await lstat(path.join(roundDir, FRAMES_INDEX)).then(
    () => true,
    (error: unknown) => errnoOf(error) !== "ENOENT",
  );
  if (!present) return null;
  const text = (await readInside(roundDir, FRAMES_INDEX, MAX_INDEX_BYTES)).toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw refusal("the round's frames index is not JSON");
  }
  const parsed = FramesIndexSchema.safeParse(json);
  if (!parsed.success) throw refusal("the round's frames index is not a frames@1 index");
  return parsed.data;
}

/** True only for a frames.json that reads and parses as frames@1; a missing or refused index is false. */
export async function hasFramesIndex(roundDir: string): Promise<boolean> {
  return readFramesIndex(roundDir).then((index) => index !== null, () => false);
}

function recordFiles(record: FramesIndex["frames"][number]): Partial<Record<FrameView, string>> {
  const files: Partial<Record<FrameView, string>> = { head: record.file };
  if (record.base) files.base = record.base.file;
  if (record.after) files.after = record.after.file;
  if (record.diff) files.diff = record.diff.file;
  return files;
}

function indexEntries(roundDir: string, index: FramesIndex | null): FrameIndex {
  const entries = new Map<string, FrameEntry>();
  const sha256 = new Map<string, string>();
  for (const record of index?.frames ?? []) {
    const entry = {
      files: recordFiles(record),
      indexed: true,
      unchanged: record.base?.sha256 === record.sha256,
      ...(record.viewport && { viewportWidth: record.viewport.width }),
      ...(record.targets && { targets: record.targets }),
    };
    entries.set(record.key, record.theme === undefined ? entry : { ...entry, theme: record.theme });
    for (const listed of [record, record.base, record.after, record.diff]) if (listed) sha256.set(canonical(roundDir, listed.file), listed.sha256);
  }
  return { present: index !== null, entries, sha256 };
}

/** Every frame the round lists: image variants give the head view; frames@1 records add base, diff, theme and sha256. */
export async function frameIndex(roundDir: string): Promise<FrameIndex> {
  const { parsed } = await readManifest(roundDir);
  if (!parsed.ok) throw refusal("the round is not a valid round");
  const index = indexEntries(roundDir, await readFramesIndex(roundDir));
  for (const variant of parsed.manifest.variants) {
    if (variant.image === undefined) continue;
    const listed = index.entries.get(variant.key);
    index.entries.set(variant.key, { ...listed, files: { ...listed?.files, head: variant.image }, indexed: listed?.indexed ?? false, unchanged: listed?.unchanged ?? false });
  }
  return index;
}

/** How each kind of file a frames record names is checked: its path, its size cap and, for a PNG, its first bytes. */
const LISTED_KINDS = {
  png: { path: IMAGE_PATH, pathRule: "a relative .png path", cap: MAX_FRAME_BYTES, signature: PNG_SIGNATURE, noun: "the PNG" },
  targets: { path: TARGETS_PATH, pathRule: "a relative .json path", cap: MAX_TARGETS_BYTES, signature: undefined, noun: "the targets file" },
} as const;
export type ListedKind = keyof typeof LISTED_KINDS;

/** The one path rule for a file a round names, shared with `round-import.ts`: a relative path of its kind that stays inside the round. */
export async function readFrameBytes(
  roundDir: string,
  rel: string,
  expectedSha256?: string,
  kind: ListedKind = "png",
): Promise<{ bytes: Buffer; sha256: string }> {
  const rule = LISTED_KINDS[kind];
  if (!rule.path.test(rel)) throw refusal(`its path is not ${rule.pathRule}`);
  const bytes = await readInside(roundDir, rel, rule.cap);
  if (rule.signature && !bytes.subarray(0, rule.signature.length).equals(rule.signature)) throw refusal("the file is not a PNG");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw refusal(`${rule.noun} does not match the frames index sha256`);
  return { bytes, sha256 };
}

/** One PNG the round's index lists, checked against the sha256 the index gives it whenever it gives one. */
export const readListedPng = (roundDir: string, index: FrameIndex, rel: string): Promise<{ bytes: Buffer; sha256: string }> =>
  readFrameBytes(roundDir, rel, index.sha256.get(canonical(roundDir, rel)));

async function readFrame(roundDir: string, index: FrameIndex, rel: string): Promise<FrameRead> {
  const { bytes, sha256 } = await readListedPng(roundDir, index, rel);
  return { contentType: "image/png", bytes: bytes.length, sha256, base64: bytes.toString("base64") };
}

export async function roundFrameIndex(dir: string, id: string): Promise<{ roundDir: string; index: FrameIndex }> {
  if (!(await roundDirExists(dir, id))) throw failure(`No round named "${id}"`, EXIT.NOINPUT);
  const roundDir = path.resolve(dir, id);
  return { roundDir, index: await frameIndex(roundDir) };
}

/** Which views each frame has, and whether frames.json lists it, so the page asks only for files the round lists. */
export async function listFrames({ dir }: RoundsSource, id: string): Promise<FramesList> {
  const { index } = await roundFrameIndex(dir, id);
  const frames = [...index.entries].map(([key, { files, theme, indexed, unchanged, viewportWidth, targets }]) => ({
    key,
    theme,
    views: FRAME_VIEWS.filter((view) => files[view] !== undefined),
    indexed,
    unchanged,
    ...(viewportWidth !== undefined && { viewportWidth }),
    ...(targets && { targets: true as const }),
  }));
  return { indexed: index.present, frames };
}

/** A frame's element map, read with the PNG's discipline: a relative .json path inside the round, no symlink, capped, sha256-checked. */
export async function getFrameTargets({ dir }: RoundsSource, id: string, key: string): Promise<TargetsRead> {
  const { roundDir, index } = await roundFrameIndex(dir, id);
  const listed = index.entries.get(key)?.targets;
  if (listed === undefined) throw refusal(`round ${id} lists no targets for "${key}"`);
  const { bytes, sha256 } = await readFrameBytes(roundDir, listed.file, listed.sha256, "targets");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw refusal("the targets file is not JSON");
  }
  const parsed = FrameTargetsSchema.safeParse(json);
  if (!parsed.success) throw refusal("the targets file is not a frame-targets@1 file");
  return { sha256, boxes: parsed.data.boxes };
}

export async function getFrame({ dir }: RoundsSource, id: string, key: string, view: FrameView): Promise<FrameRead> {
  const { roundDir, index } = await roundFrameIndex(dir, id);
  const file = index.entries.get(key)?.files[view];
  if (file === undefined) throw refusal(`round ${id} lists no ${view} view of "${key}"`);
  return readFrame(roundDir, index, file);
}

export function roundFramesCommands(source: RoundsSource) {
  return {
    "rounds.frame": readCommand({
      name: "rounds.frame",
      description: "One PNG a review round lists, by frame key and view (head, base, after or diff), as base64 with its sha256",
      args: z.object({ id: z.string().regex(ROUND_ID), key: z.string().regex(FRAME_KEY), view: z.enum(FRAME_VIEWS).default("head") }),
      result: frameResult,
      run: ({ id, key, view }) => getFrame(source, id, key, view),
    }),
    "rounds.frames": readCommand({
      name: "rounds.frames",
      description: "Every frame a review round lists, with its theme, the views (head, base, after, diff) it has files for, whether frames.json lists it and whether its base and head are byte-identical",
      args: z.object({ id: z.string().regex(ROUND_ID) }),
      result: framesResult,
      run: ({ id }) => listFrames(source, id),
    }),
    "rounds.frameTargets": readCommand({
      name: "rounds.frameTargets",
      description: "The element boxes a review round's frames.json names for one frame key, sha256-checked, so a pin on the PNG can say which element it sits on",
      args: z.object({ id: z.string().regex(ROUND_ID), key: z.string().regex(FRAME_KEY) }),
      result: targetsResult,
      run: ({ id, key }) => getFrameTargets(source, id, key),
    }),
  };
}
