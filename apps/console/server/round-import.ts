/**
 * `importRound`: copies a review-harness round dir into the console's rounds dir as `<unit>-r<round>/`.
 * It writes `round.json`, whose Ship questions bind a merge head, and `feedback.json`, an answer file,
 * into the dir the owner-write path trusts, so it refuses anything it cannot validate and a refusal
 * writes nothing.
 *
 * `round.json` and `feedback.json` are judged by the same parsers the console reads them with, so an
 * import never lands a round the page would list as invalid. It refuses a round that breaks the builder rules
 * (`round-rules.ts`), naming each rule. It also refuses a "Merge #N", "Ship" or "#N at <sha>"
 * offer with no agreeing merge binding (`round-merge-binding.ts`), which the page still lists, and a Ship round that is not
 * one clean main-vs-head package (`round-ship-package.ts`). `frames/frames.json` must name the
 * round.json bytes it was built for; it is copied with only the files it lists (each record's PNGs and its optional
 * `targets` element map), each read through `round-frames.ts`'s reader and checked against its sha256. A `packet.json` or `prose.json` it names is
 * copied beside round.json, sha256-checked, and the packet must bind the PR and head the round's Ship
 * questions merge, because the factory's Ship answer route trusts it there. A new round is built in a dot-named
 * staging dir, which `ROUND_ID` hides from `listRounds`, and renamed into place. A re-import of the
 * same round.json and frames.json adds missing frames and a missing feedback.json; it never replaces a file, and it refuses
 * (before writing) a destination frame whose sha256 differs from the index or whose path crosses a symlink.
 *
 * A round may carry a static Storybook build (TP-3793): `storybook/storybook.json`, a storybook@1 sidecar, and the
 * files it lists under `storybook/static/`. The build is copied once into the console's store by its content id
 * (`storybook-store.ts`), every file sha256-checked, before the round itself is written, and the sidecar is copied
 * beside round.json; a round imported again with a different sidecar is refused. A multi-PR round carries a
 * storybook-set@1 sidecar instead, with each build's files under `storybook/builds/<sha>/`; every build must be one
 * PR group's head, and each is stored the same way.
 *
 * Once the round is in place, each still-open round its `supersedes` names is withdrawn (`round-supersede.ts`, TP-3990);
 * every target's outcome is reported, and none of them can refuse the import.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { FramesIndexSchema, readFrameBytes, type ListedKind } from "./round-frames.js";
import { mergeBindingProblems } from "./round-merge-binding.js";
import { roundRuleRefusal } from "./round-rules.js";
import { shipPackageProblems } from "./round-ship-package.js";
import { withdrawSuperseded, type SupersedeOutcome } from "./round-supersede.js";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, ROUND_FILE, ROUND_ID, parseFeedback, parseManifest, readCapped } from "./rounds.js";
import { STORYBOOK_DIR, STORYBOOK_FILE, buildSetProblems } from "./storybook-build.js";
import { readSourceStorybook, storeBuild, type SourceStorybook } from "./storybook-store.js";

const MAX_FRAMES = 1000;
const FRAMES_DIR = "frames";
const FRAMES_INDEX = "frames.json";
const FRAMES_INDEX_PATH = path.join(FRAMES_DIR, FRAMES_INDEX);
/** What `rename` raises when another import put a non-empty dir at the destination first. */
const RACED = new Set(["EEXIST", "ENOTEMPTY"]);
const PACKET_FILE = "packet.json";
const PROSE_FILE = "prose.json";
const STORYBOOK_PATH = path.join(STORYBOOK_DIR, STORYBOOK_FILE);

/** The fields the factory's Ship answer route binds; a packet's other fields pass through unread. */
const PacketBinding = z.object({ schema: z.literal("titan-review/ci-packet@1"), repo: z.string(), pr: z.number().int(), headSha: z.string() });

export interface ImportResult {
  id: string;
  created: boolean;
  /** Distinct files the frames index lists (PNGs and targets files), all present in the destination after the import. */
  frames: number;
  feedback: "copied" | "kept" | "none";
  /** Present when round.json lists `supersedes`: what became of each named round. */
  superseded?: SupersedeOutcome[];
}

interface SourceRound {
  dir: string;
  id: string;
  round: number;
  supersedes: string[];
  roundBytes: Buffer;
  /** `frames/frames.json` as read, copied verbatim so `rounds.frame` finds the base, after and diff views. */
  index: Buffer | null;
  /** sha256 and kind by the file's normalised path relative to the round dir. */
  frames: Map<string, ListedFile>;
  /** `packet.json` and `prose.json` when frames.json names them, keyed by file name. */
  sidecars: Map<string, Buffer>;
  feedback: Buffer | null;
  storybook: SourceStorybook | null;
}

type FramesIndex = z.infer<typeof FramesIndexSchema>;
type Listed = { file: string; sha256: string };
type ListedFile = { sha256: string; kind: ListedKind };
type ShipBinding = { repo: string; pr: number; headSha: string };

interface Binding {
  unit: string;
  round: number;
  manifestSha256: string;
}

const refuse = (message: string, code: number = EXIT.DATAERR): never => {
  throw failure(`import refused: ${message}`, code);
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** A `failure` carries a sysexits number; a raw fs error carries an errno string. */
const isFailure = (error: unknown): boolean => error instanceof Error && "code" in error && typeof error.code === "number";

const lstatOrNull = (file: string) =>
  lstat(file).catch((error: unknown) => (errnoOf(error) === "ENOENT" ? null : refuse(`${path.basename(file)} could not be checked`)));

/** Null when the file is absent; a symlink, a non-regular file or an oversized file is refused. */
async function readTopFile(dir: string, name: string): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(dir, name), OPEN_FLAGS);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    return refuse(errnoOf(error) === "ELOOP" ? `${name} is a symlink` : `${name} could not be opened`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) refuse(`${name} is not a regular file`);
    const bytes = stats.size > MAX_ROUND_BYTES ? null : await readCapped(handle, MAX_ROUND_BYTES);
    return bytes ?? refuse(`${name} is over ${MAX_ROUND_BYTES} bytes`);
  } finally {
    await handle.close();
  }
}

async function assertSourceDirs(dir: string): Promise<void> {
  if (!(await lstatOrNull(dir))?.isDirectory()) refuse("the source is not a directory (a symlink is refused)", EXIT.NOINPUT);
  const frames = await lstatOrNull(path.join(dir, FRAMES_DIR));
  if (frames && !frames.isDirectory()) refuse(`${FRAMES_DIR}/ is a symlink or not a directory`);
}

function checkBinding(index: FramesIndex, binding: Binding): void {
  if (index.manifestSha256 !== binding.manifestSha256) refuse("frames.json does not name the sha256 of this round.json");
  if (index.unit !== binding.unit || index.round !== binding.round) refuse("frames.json is for another round");
  if (index.frames.length > MAX_FRAMES) refuse(`frames.json lists over ${MAX_FRAMES} frames`);
  if (new Set(index.frames.map((record) => record.key)).size !== index.frames.length) refuse("frames.json repeats a frame key");
}

async function readIndex(dir: string): Promise<{ bytes: Buffer; index: FramesIndex } | null> {
  const bytes = await readTopFile(path.join(dir, FRAMES_DIR), FRAMES_INDEX);
  if (bytes === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse(`${FRAMES_INDEX} is not JSON`);
  }
  const parsed = FramesIndexSchema.safeParse(json);
  return parsed.success ? { bytes, index: parsed.data } : refuse(`${FRAMES_INDEX} is not a frames@1 index`);
}

/** Every listed file is read and checked here, before anything is written. */
async function readFrameList(dir: string, index: FramesIndex, binding: Binding): Promise<Map<string, ListedFile>> {
  const frames = new Map<string, ListedFile>();
  checkBinding(index, binding);
  const listedFiles = index.frames.flatMap((record) => [
    ...[record, record.base, record.diff, record.after].map((listed) => listed && { ...listed, kind: "png" as const }),
    record.targets && { ...record.targets, kind: "targets" as const },
  ]);
  for (const listed of listedFiles) {
    if (listed === undefined) continue;
    await readFrameBytes(dir, listed.file, listed.sha256, listed.kind);
    const rel = path.normalize(listed.file);
    const seen = frames.get(rel);
    if (seen && (seen.sha256 !== listed.sha256 || seen.kind !== listed.kind)) refuse("frames.json gives one file two sha256s or kinds");
    frames.set(rel, { sha256: listed.sha256, kind: listed.kind });
  }
  return frames;
}

/** Null when frames.json does not name the file; it must sit beside round.json, as the factory reads it there. */
async function readSidecar(dir: string, name: string, listed: Listed | undefined): Promise<{ bytes: Buffer; json: unknown } | null> {
  if (listed === undefined) return null;
  if (listed.file !== name) refuse(`frames.json must name ${name} beside round.json, not "${listed.file}"`);
  const bytes = (await readTopFile(dir, name)) ?? refuse(`frames.json names ${name} but the source has none`);
  if (sha256(bytes) !== listed.sha256) refuse(`${name} does not match the frames.json sha256`);
  try {
    return { bytes, json: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return refuse(`${name} is not JSON`);
  }
}

function checkPacket(json: unknown, ships: ShipBinding[]): void {
  const parsed = PacketBinding.safeParse(json);
  if (!parsed.success) return refuse(`${PACKET_FILE} is not a ci-packet@1 packet`);
  const { repo, pr, headSha } = parsed.data;
  if (ships.length === 0) refuse(`${PACKET_FILE} binds ${repo}#${pr} but round.json has no merge-bound Ship question`);
  const other = ships.find((ship) => ship.repo !== repo || ship.pr !== pr || ship.headSha !== headSha);
  if (other) refuse(`${PACKET_FILE} binds ${repo}#${pr} at ${headSha}, a Ship question ${other.repo}#${other.pr} at ${other.headSha}`);
}

async function readSidecars(dir: string, index: FramesIndex | undefined, ships: ShipBinding[]): Promise<Map<string, Buffer>> {
  const sidecars = new Map<string, Buffer>();
  const packet = await readSidecar(dir, PACKET_FILE, index?.packet);
  if (packet) checkPacket(packet.json, ships);
  const prose = await readSidecar(dir, PROSE_FILE, index?.prose);
  if (packet) sidecars.set(PACKET_FILE, packet.bytes);
  if (prose) sidecars.set(PROSE_FILE, prose.bytes);
  return sidecars;
}

async function readFeedbackFor(dir: string, binding: Binding): Promise<Buffer | null> {
  const bytes = await readTopFile(dir, FEEDBACK_FILE);
  if (bytes === null) return null;
  const read = parseFeedback(bytes.toString("utf8"));
  if (!read.ok) return refuse(read.reason);
  const { unit, round, manifestSha256 } = read.feedback ?? refuse(`${FEEDBACK_FILE} is empty`);
  if (unit !== binding.unit || round !== binding.round || manifestSha256 !== binding.manifestSha256) {
    refuse(`${FEEDBACK_FILE} answers another round.json`);
  }
  return bytes;
}

async function readSource(dir: string): Promise<SourceRound> {
  await assertSourceDirs(dir);
  const roundBytes = (await readTopFile(dir, ROUND_FILE)) ?? refuse(`the source has no ${ROUND_FILE}`, EXIT.NOINPUT);
  const parsed = parseManifest(roundBytes);
  if (!parsed.ok) return refuse(`${ROUND_FILE}: ${parsed.reason}`);
  const { unit, round, questions } = parsed.manifest;
  const unbound = mergeBindingProblems(questions);
  if (unbound.length > 0) refuse(`${ROUND_FILE}: ${unbound.join("; ")}`);
  const id = `${unit}-r${round}`;
  if (!ROUND_ID.test(id)) refuse(`round id "${id}" is not a plain name`);
  const binding = { unit, round, manifestSha256: sha256(roundBytes) };
  const read = await readIndex(dir);
  const unclean = shipPackageProblems(parsed.manifest, read?.index.frames ?? []);
  if (unclean.length > 0) refuse(`${ROUND_FILE}: ${unclean.join("; ")}`);
  const broken = roundRuleRefusal(parsed.manifest);
  if (broken !== null) refuse(broken);
  const frames = read ? await readFrameList(dir, read.index, binding) : new Map<string, ListedFile>();
  const sidecars = await readSidecars(dir, read?.index, questions.flatMap((question) => ("merge" in question && question.merge ? [question.merge] : [])));
  const storybook = await readSourceStorybook(dir);
  const misfit = storybook?.set ? buildSetProblems(parsed.manifest, storybook.builds) : [];
  if (misfit.length > 0) refuse(`${STORYBOOK_PATH}: ${misfit.join("; ")}`);
  const supersedes = parsed.manifest.supersedes ?? [];
  return { dir, id, round, supersedes, roundBytes, index: read?.bytes ?? null, frames, sidecars, feedback: await readFeedbackFor(dir, binding), storybook };
}

/** False when the file already exists; `wx` also refuses a symlink planted at the name. */
async function writeNew(file: string, bytes: Buffer): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return true;
}

/** Each directory between the round dir and the file is created 0700 (unless `create` is false) or must already be a real directory. */
async function ensureParents(root: string, rel: string, create = true): Promise<void> {
  let at = root;
  for (const part of path.dirname(rel).split(path.sep).filter((segment) => segment !== ".")) {
    at = path.join(at, part);
    const stats = await lstatOrNull(at);
    if (stats === null) {
      if (!create) return;
      await mkdir(at, { mode: 0o700 });
    } else if (!stats.isDirectory()) refuse(`a directory on the path of ${rel} is a symlink or not a directory`);
  }
}

/**
 * Everything `writeFrames` could refuse in an existing round, checked before its first write: every parent it would
 * write into is a real directory, and a frame already there is the one the index names, never kept on trust.
 */
async function checkDestFrames(source: SourceRound, dest: string): Promise<void> {
  const written = [...(source.index === null ? [] : [FRAMES_INDEX_PATH]), ...(source.storybook === null ? [] : [STORYBOOK_PATH])];
  for (const rel of [...source.frames.keys(), ...written]) await ensureParents(dest, rel, false);
  for (const [rel, { sha256: expected, kind }] of source.frames) {
    if (!(await lstatOrNull(path.join(dest, rel)))) continue;
    await readFrameBytes(dest, rel, expected, kind).catch((error: unknown) => {
      if (isFailure(error)) refuse(`round ${source.id} holds ${rel}, which is not the frame frames.json names; it is not overwritten`);
      throw error;
    });
  }
}

/**
 * Copies each listed frame the target lacks, read again through the frame reader so a file swapped since the check is
 * refused, then the Storybook sidecar, frames.json, packet.json and prose.json where the target has none.
 */
async function writeFrames(source: SourceRound, target: string): Promise<void> {
  if (source.storybook) {
    await ensureParents(target, STORYBOOK_PATH);
    await writeNew(path.join(target, STORYBOOK_PATH), source.storybook.bytes);
  }
  for (const [rel, { sha256: expected, kind }] of source.frames) {
    await ensureParents(target, rel);
    if (await lstatOrNull(path.join(target, rel))) continue;
    const { bytes } = await readFrameBytes(source.dir, rel, expected, kind);
    await writeNew(path.join(target, rel), bytes);
  }
  if (source.index === null) return;
  await ensureParents(target, FRAMES_INDEX_PATH);
  await writeNew(path.join(target, FRAMES_INDEX_PATH), source.index);
  for (const [name, bytes] of source.sidecars) await writeNew(path.join(target, name), bytes);
}

/** The build lands in the store before the round that names it, so a listed round never points at a missing build. */
async function storeSourceBuild(source: SourceRound, storybooksDir: string | undefined): Promise<void> {
  if (source.storybook === null) return;
  const store = storybooksDir ?? refuse("the round carries a Storybook build but this console has no store for it");
  for (const { build, buildId, staticDir } of source.storybook.builds) await storeBuild({ storybooksDir: path.resolve(store), staticDir, build, buildId });
}

/** Null when another import renamed its own round into place first. */
async function stageAndRename(source: SourceRound, roundsDir: string, dest: string, storybooksDir: string | undefined): Promise<ImportResult | null> {
  await storeSourceBuild(source, storybooksDir);
  const stage = await mkdtemp(path.join(roundsDir, `.import-${source.id}-${process.pid}-`));
  try {
    await writeNew(path.join(stage, ROUND_FILE), source.roundBytes);
    await writeFrames(source, stage);
    if (source.feedback) await writeNew(path.join(stage, FEEDBACK_FILE), source.feedback);
    await rename(stage, dest);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (RACED.has(errnoOf(error) ?? "")) return null;
    throw error;
  }
  return { id: source.id, created: true, frames: source.frames.size, feedback: source.feedback ? "copied" : "none" };
}

async function keepOrCopyFeedback(source: SourceRound, dest: string): Promise<ImportResult["feedback"]> {
  if (await lstatOrNull(path.join(dest, FEEDBACK_FILE))) return "kept";
  if (source.feedback === null) return "none";
  return (await writeNew(path.join(dest, FEEDBACK_FILE), source.feedback)) ? "copied" : "kept";
}

async function checkDestStorybook(source: SourceRound, dest: string): Promise<void> {
  if (source.storybook === null) return;
  const held = await readTopFile(path.join(dest, STORYBOOK_DIR), STORYBOOK_FILE);
  if (held !== null && !held.equals(source.storybook.bytes)) refuse(`round ${source.id} is already imported with a different ${STORYBOOK_FILE}`);
}

async function reconcile(source: SourceRound, dest: string, storybooksDir: string | undefined): Promise<ImportResult> {
  if (!(await lstatOrNull(dest))?.isDirectory()) refuse(`${source.id} in the rounds dir is a symlink or not a directory`);
  const existing = (await readTopFile(dest, ROUND_FILE)) ?? refuse(`round ${source.id} exists without a ${ROUND_FILE}`);
  if (!existing.equals(source.roundBytes)) {
    refuse(`round ${source.id} is already imported with a different ${ROUND_FILE}; build round ${source.round + 1}`);
  }
  const index = await readTopFile(path.join(dest, FRAMES_DIR), FRAMES_INDEX);
  if (index !== null && !(source.index?.equals(index) ?? false)) refuse(`round ${source.id} is already imported with a different ${FRAMES_INDEX}`);
  await checkDestFrames(source, dest);
  await checkDestStorybook(source, dest);
  await storeSourceBuild(source, storybooksDir);
  await writeFrames(source, dest);
  return { id: source.id, created: false, frames: source.frames.size, feedback: await keepOrCopyFeedback(source, dest) };
}

async function importInto(source: SourceRound, roundsDir: string, storybooksDir: string | undefined): Promise<ImportResult> {
  await mkdir(roundsDir, { recursive: true, mode: 0o700 });
  const dest = path.join(roundsDir, source.id);
  if ((await lstatOrNull(dest)) === null) {
    const created = await stageAndRename(source, roundsDir, dest, storybooksDir);
    if (created) return created;
  }
  return reconcile(source, dest, storybooksDir);
}

export async function importRound({ source, roundsDir, storybooksDir }: { source: string; roundsDir: string; storybooksDir?: string }): Promise<ImportResult> {
  const round = await readSource(path.resolve(source));
  const result = await importInto(round, path.resolve(roundsDir), storybooksDir).catch((error: unknown) => {
    if (isFailure(error)) throw error;
    throw failure(`import failed: the rounds dir could not be written (${errnoOf(error) ?? "unknown"})`, EXIT.UNAVAILABLE);
  });
  if (round.supersedes.length === 0) return result;
  return { ...result, superseded: await withdrawSuperseded(roundsDir, round.id, round.supersedes) };
}
