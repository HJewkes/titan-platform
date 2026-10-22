/**
 * `rounds.get`'s `live` field (TP-3793): for a round that carries a Storybook build, each story
 * variant's url on the story origin, or the reason it shows its captured PNG instead. Only urls are
 * produced here; nothing is served. The round's `storybook/storybook.json` is read with the frame
 * reader's discipline, the build's `index.json` from the console's store with its sha256 checked,
 * and frames.json lends each record's theme.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { frameIndex, readRoundBytes } from "./round-frames.js";
import type { Manifest } from "./round-schema.js";
import {
  INDEX_FILE,
  MAX_SIDECAR_BYTES,
  STORYBOOK_DIR,
  STORYBOOK_FILE,
  hasStoryVariants,
  indexedStories,
  liveFrames,
  sidecarOf,
  unavailableFrames,
  type LiveBuild,
  type RoundLive,
  type Sidecar,
  type SidecarBuild,
  type Theme,
} from "./storybook-build.js";
import { readStoredFile } from "./storybook-store.js";

/** `remote`: the call came through the LAN listener, whose pages frame the LAN story origin. */
export type LiveReader = (roundDir: string, manifest: Manifest, remote?: boolean) => Promise<RoundLive | undefined>;

const SIDECAR = path.join(STORYBOOK_DIR, STORYBOOK_FILE);

const parseJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The builds an imported round names, null when it carries none; a sidecar that is there but unreadable is a reason,
 * never a throw. The store's GC counts references through this same read.
 */
export async function readRoundSidecar(roundDir: string): Promise<Sidecar | { reason: string } | null> {
  const present = await lstat(path.join(roundDir, STORYBOOK_DIR)).then(() => true, () => false);
  if (!present) return null;
  const bytes = await readRoundBytes(roundDir, SIDECAR, MAX_SIDECAR_BYTES).catch(() => null);
  if (bytes === null) return { reason: `the round's ${STORYBOOK_FILE} could not be read` };
  return sidecarOf(parseJson(bytes)) ?? { reason: `the round's ${STORYBOOK_FILE} is not a storybook@1 or storybook-set@1 sidecar` };
}

async function readStories(storybooksDir: string, { build, buildId }: SidecarBuild): Promise<Set<string> | string> {
  const listed = build.files.find((file) => file.path === INDEX_FILE);
  if (listed === undefined) return `the build lists no ${INDEX_FILE}`;
  const read = await readStoredFile(storybooksDir, buildId, listed);
  if (!read.ok) return read.reason;
  return indexedStories(parseJson(read.bytes)) ?? `the build's ${INDEX_FILE} is not a Storybook index`;
}

/** A frames.json that cannot be read lends no themes; the PNG views report that themselves. */
async function frameThemes(roundDir: string): Promise<Map<string, Theme>> {
  const index = await frameIndex(roundDir).catch(() => null);
  return new Map([...(index?.entries ?? [])].flatMap(([key, { theme }]): [string, Theme][] => (theme === undefined ? [] : [[key, theme]])));
}

async function readLive(storybooksDir: string, roundDir: string, manifest: Manifest): Promise<RoundLive | undefined> {
  if (!hasStoryVariants(manifest)) return undefined;
  const sidecar = await readRoundSidecar(roundDir);
  if (sidecar === null) return undefined;
  if ("reason" in sidecar) return { origin: null, frames: unavailableFrames(manifest, sidecar.reason) };
  const builds = await Promise.all(sidecar.builds.map(async (entry): Promise<LiveBuild> => ({ ...entry, stories: await readStories(storybooksDir, entry) })));
  const themes = await frameThemes(roundDir);
  return { origin: null, frames: liveFrames({ manifest, builds, themes }) };
}

export const storybookLiveReader =
  (storybooksDir: string): LiveReader =>
  (roundDir, manifest) =>
    readLive(storybooksDir, roundDir, manifest);
