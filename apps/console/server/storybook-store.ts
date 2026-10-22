/**
 * The console's store of static Storybook builds, one `<storybooksDir>/<buildId>/` per build, where
 * buildId is the sha256 of the build's file list (`storybook-build.ts`). Rounds that ship the same
 * bytes share one copy. A build is written once, through a dot-named staging dir renamed into place,
 * and never changed after: a build already there is kept, as its name is its content. A build leaves only through
 * `removeStoredBuild`, which the GC sweep (`storybook-gc.ts`) calls.
 *
 * The source is another process's round dir, so each file is read the way `round-frames.ts` reads
 * a frame: every directory on its path lstat'd, opened O_NOFOLLOW and O_NONBLOCK, a regular file of
 * exactly its listed size, its sha256 checked against the listing. One bad file refuses the whole
 * build and leaves the store as it was. Reads go through `@titan-design/daemon`'s `containedFile`,
 * the same containment the story origin serves with.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { containedFile } from "@titan-design/daemon";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { OPEN_FLAGS, readCapped } from "./rounds.js";
import { BUILD_ID, MAX_SIDECAR_BYTES, STORYBOOK_DIR, STORYBOOK_FILE, buildListProblems, sidecarOf, type BuildFile, type Sidecar, type StorybookBuild } from "./storybook-build.js";

/** What `rename` raises when another import put the same build in place first. */
const RACED = new Set(["EEXIST", "ENOTEMPTY"]);

const refuse = (message: string): never => {
  throw failure(`storybook build refused: ${message}`, EXIT.DATAERR);
};

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function assertRealDirs(root: string, rel: string): Promise<void> {
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = path.join(at, part);
    if (!(await lstat(at).catch(() => null))?.isDirectory()) refuse(`a directory on the path of ${rel} is a symlink or missing`);
  }
}

async function openSource(file: string, rel: string): Promise<FileHandle> {
  try {
    return await open(file, OPEN_FLAGS);
  } catch (error) {
    const code = errnoOf(error);
    return refuse(code === "ELOOP" ? `${rel} is a symlink` : code === "ENOENT" ? `the build has no ${rel}` : `${rel} could not be opened`);
  }
}

/** The bytes of one listed file, refused unless they are exactly the listed size and sha256. */
async function readListed(staticDir: string, file: BuildFile): Promise<Buffer> {
  await assertRealDirs(staticDir, file.path);
  const handle = await openSource(path.join(staticDir, ...file.path.split("/")), file.path);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) refuse(`${file.path} is not a regular file`);
    if (stats.size !== file.bytes) refuse(`${file.path} is not the ${file.bytes} bytes storybook.json lists`);
    const bytes = (await readCapped(handle, file.bytes)) ?? refuse(`${file.path} changed while it was read`);
    if (sha256(bytes) !== file.sha256) refuse(`${file.path} does not match the storybook.json sha256`);
    return bytes;
  } finally {
    await handle.close();
  }
}

interface SourceBuild {
  build: StorybookBuild;
  buildId: string;
  staticDir: string;
}

export interface SourceStorybook {
  /** `storybook/storybook.json` as read, copied verbatim so `rounds.get` reads the builds the store was given. */
  bytes: Buffer;
  /** True for a storybook-set@1 sidecar, whose builds the import checks against the round's PR groups. */
  set: boolean;
  builds: SourceBuild[];
}

async function readSidecarBytes(storybookDir: string): Promise<Buffer> {
  const handle = await openSource(path.join(storybookDir, STORYBOOK_FILE), STORYBOOK_FILE);
  try {
    if (!(await handle.stat()).isFile()) refuse(`${STORYBOOK_FILE} is not a regular file`);
    return (await readCapped(handle, MAX_SIDECAR_BYTES)) ?? refuse(`${STORYBOOK_FILE} is over ${MAX_SIDECAR_BYTES} bytes`);
  } finally {
    await handle.close();
  }
}

const parseSidecar = (bytes: Buffer): Sidecar => {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse(`${STORYBOOK_FILE} is not JSON`);
  }
  return sidecarOf(json) ?? refuse(`${STORYBOOK_FILE} is not a storybook@1 or storybook-set@1 sidecar`);
};

/** Every directory from `storybook/` down to a build's files is real, so no build is read through a symlink. */
async function sourceStaticDir(storybookDir: string, staticRel: string): Promise<string> {
  let at = storybookDir;
  for (const part of staticRel.split("/")) {
    at = path.join(at, part);
    if (!(await lstat(at).catch(() => null))?.isDirectory()) refuse(`${STORYBOOK_DIR}/${staticRel}/ is missing, a symlink or not a directory`);
  }
  return at;
}

/** Null when a round dir has no `storybook/`; `storeBuild` checks each file list, before the import writes anything. */
export async function readSourceStorybook(roundDir: string): Promise<SourceStorybook | null> {
  const storybookDir = path.join(roundDir, STORYBOOK_DIR);
  const held = await lstat(storybookDir).catch(() => null);
  if (held === null) return null;
  if (!held.isDirectory()) refuse(`${STORYBOOK_DIR}/ is a symlink or not a directory`);
  const bytes = await readSidecarBytes(storybookDir);
  const { set, builds } = parseSidecar(bytes);
  const sources: SourceBuild[] = [];
  for (const { build, buildId, staticRel } of builds) sources.push({ build, buildId, staticDir: await sourceStaticDir(storybookDir, staticRel) });
  return { bytes, set, builds: sources };
}

async function copyInto(stage: string, staticDir: string, files: readonly BuildFile[]): Promise<void> {
  for (const file of files) {
    const bytes = await readListed(staticDir, file);
    const target = path.join(stage, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
}

/** False when the store already held the build; a build id that is not a sha256 is refused before any path is made. */
export async function storeBuild({ storybooksDir, staticDir, build, buildId }: { storybooksDir: string; staticDir: string; build: StorybookBuild; buildId: string }): Promise<boolean> {
  if (!BUILD_ID.test(buildId)) refuse("its id is not a sha256");
  const problems = buildListProblems(build.files);
  if (problems.length > 0) refuse(problems.join("; "));
  await mkdir(storybooksDir, { recursive: true, mode: 0o700 });
  const dest = path.join(storybooksDir, buildId);
  const held = await lstat(dest).catch(() => null);
  if (held) return held.isDirectory() ? false : refuse(`the store holds ${buildId} as a symlink or file`);
  const stage = await mkdtemp(path.join(storybooksDir, `.stage-${buildId.slice(0, 12)}-`));
  try {
    await copyInto(stage, staticDir, build.files);
    await rename(stage, dest);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (RACED.has(errnoOf(error) ?? "")) return false;
    throw error;
  }
  return true;
}

export interface StoredBuild {
  buildId: string;
  /** The regular files under the build; a symlink inside it counts nothing and is never followed. */
  bytes: number;
  storedAt: Date;
}

async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(at);
    else if (entry.isFile()) total += (await lstat(at)).size;
  }
  return total;
}

/**
 * The store's builds: the real directories named by a build id. Anything else at the top, such as a staging dir, a
 * symlink or a stray file, is listed in `skipped` and never touched. A missing store holds no builds.
 */
export async function listStoredBuilds(storybooksDir: string): Promise<{ builds: StoredBuild[]; skipped: string[] }> {
  const entries = await readdir(storybooksDir, { withFileTypes: true }).catch((error: unknown) => (errnoOf(error) === "ENOENT" ? [] : Promise.reject(error)));
  const builds: StoredBuild[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const dir = path.join(storybooksDir, entry.name);
    if (!BUILD_ID.test(entry.name) || !entry.isDirectory()) {
      skipped.push(entry.name);
      continue;
    }
    builds.push({ buildId: entry.name, bytes: await bytesUnder(dir), storedAt: (await lstat(dir)).mtime });
  }
  return { builds, skipped };
}

/**
 * Takes a build out of the store. The build's own name is renamed to a dot-named dir first, so a reader sees it gone at
 * once, and that dir is removed. Nothing is resolved: a symlink at the name is refused, and `rm` unlinks a symlink inside
 * the build rather than following it.
 */
export async function removeStoredBuild(storybooksDir: string, buildId: string): Promise<void> {
  if (!BUILD_ID.test(buildId)) refuse("its id is not a sha256");
  const dir = path.join(storybooksDir, buildId);
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) refuse(`the store holds ${buildId} as a symlink, a file or nothing`);
  const doomed = path.join(storybooksDir, `.gc-${buildId.slice(0, 12)}-${randomUUID()}`);
  await rename(dir, doomed);
  await rm(doomed, { recursive: true, force: true });
}

type StoredRead ={ ok: true; bytes: Buffer } | { ok: false; reason: string };

/** One file of a stored build, checked against the sha256 its round's storybook.json lists for it. */
export async function readStoredFile(storybooksDir: string, buildId: string, file: BuildFile): Promise<StoredRead> {
  if (!BUILD_ID.test(buildId)) return { ok: false, reason: "the build id is not a sha256" };
  const found = await containedFile(path.join(storybooksDir, buildId), file.path);
  if (found.kind === "refused") return { ok: false, reason: `the stored build's ${file.path} leads outside the build` };
  if (found.kind === "missing") return { ok: false, reason: "the build is not in the console's store" };
  const bytes = await readFile(found.file).catch(() => null);
  if (bytes === null || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) return { ok: false, reason: `the stored build's ${file.path} does not match its storybook.json` };
  return { ok: true, bytes };
}
