/**
 * A round's static Storybook build (TP-3793): the storybook@1 sidecar a round carries at
 * `storybook/storybook.json`, the content-hash id the store files it under, and the checks that
 * decide which of the round's story variants may show live. A multi-PR round carries a storybook-set@1
 * sidecar instead, one build per PR group, and each variant shows its own group's. Everything here is pure; the copy is
 * `storybook-store.ts` and the reads are `round-live.ts`.
 *
 * `storyUrl` and `urlParamProblems` are ported from review-harness `src/round.ts` (titan-design
 * 0ceb2dbb). TD-c exports them from review-schema; the console swaps to that export and deletes
 * this copy when it is released.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { THEME_MODES } from "@titan-design/review-schema";
import type { Manifest } from "./round-schema.js";

export const STORYBOOK_DIR = "storybook";
export const STORYBOOK_FILE = "storybook.json";
/** The build's files, relative to the round dir; `files[].path` is relative to this. */
const STORYBOOK_STATIC = "static";
const MAX_BUILD_FILES = 5000;
const MAX_BUILD_BYTES = 100 * 1024 * 1024;
export const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
export const BUILD_ID = /^[0-9a-f]{64}$/;
const MAX_PATH = 512;
/** The files the live frame needs: the story host page and the index the story-id check reads. */
export const IFRAME_FILE = "iframe.html";
export const INDEX_FILE = "index.json";
/** No dot first (so no `.`, `..` or dotfile, which the story origin never serves), no slash, backslash, colon or control character. */
const PATH_SEGMENT = /^[^./\\:\p{Cc}][^/\\:\p{Cc}]*$/u;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const sha40 = z.string().regex(/^[0-9a-f]{40}$/);

const BuildFileSchema = z.object({ path: z.string().min(1).max(MAX_PATH), sha256: sha256Hex, bytes: z.number().int().nonnegative() });

/** storybook@1 as TD-a's `titan-review --storybook-build` writes it. TD-c moves it into review-schema. */
const StorybookBuildSchema = z.object({
  schema: z.literal("titan-review/storybook@1"),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  sha: sha40,
  dirty: z.boolean(),
  builtAt: z.string(),
  storybookVersion: z.string(),
  storyIds: z.number().int().nonnegative(),
  files: z.array(BuildFileSchema),
});
export type StorybookBuild = z.infer<typeof StorybookBuildSchema>;
export type BuildFile = z.infer<typeof BuildFileSchema>;

/** A multi-PR round's builds sit at `storybook/builds/<sha>/`, one per PR group head (TP-3896). */
const STORYBOOK_BUILDS = "builds";
const MAX_SET_BUILDS = 20;

/** storybook-set@1: one storybook@1 build per PR group, each keyed by its `sha`. */
const StorybookSetSchema = z.object({
  schema: z.literal("titan-review/storybook-set@1"),
  builds: z.array(StorybookBuildSchema).min(1).max(MAX_SET_BUILDS),
});

export interface SidecarBuild {
  build: StorybookBuild;
  buildId: string;
  /** The dir holding the build's files, relative to the round's `storybook/`. */
  staticRel: string;
}

/** `set` is false for a single storybook@1 sidecar, whose files sit at `storybook/static/` as before TP-3896. */
export interface Sidecar {
  set: boolean;
  builds: SidecarBuild[];
}

const sidecarBuild = (build: StorybookBuild, staticRel: string): SidecarBuild => ({ build, buildId: buildIdOf(build.files), staticRel });

/** The builds a parsed `storybook.json` names, or null when it is neither a storybook@1 nor a storybook-set@1 sidecar. */
export function sidecarOf(json: unknown): Sidecar | null {
  const single = StorybookBuildSchema.safeParse(json);
  if (single.success) return { set: false, builds: [sidecarBuild(single.data, STORYBOOK_STATIC)] };
  const set = StorybookSetSchema.safeParse(json);
  if (!set.success) return null;
  return { set: true, builds: set.data.builds.map((build) => sidecarBuild(build, `${STORYBOOK_BUILDS}/${build.sha}`)) };
}

/** Why a storybook-set@1 sidecar does not fit its round: every build is one PR group's head, and no head has two. */
export function buildSetProblems(manifest: Manifest, builds: readonly { build: { sha: string } }[]): string[] {
  const heads = new Set((manifest.prGroups ?? []).map((group) => group.headSha));
  const shas = builds.map(({ build }) => build.sha);
  return [
    ...(heads.size === 0 ? ["a storybook-set@1 sidecar needs a round with prGroups"] : []),
    ...(new Set(shas).size === shas.length ? [] : ["the storybook-set@1 sidecar lists one sha twice"]),
    ...shas.filter((sha) => heads.size > 0 && !heads.has(sha)).map((sha) => `build ${sha7(sha)} is no PR group's head`),
  ];
}

/** Storybook's static `index.json`: only the entry ids and types are read. */
const StoryIndexSchema = z.object({ entries: z.record(z.string(), z.object({ type: z.string() })) });

const liveFrame = z.union([
  z.object({ url: z.string(), buildSha: z.string(), dirty: z.literal(true).optional() }),
  z.object({ reason: z.string() }),
]);
export type LiveFrame = z.infer<typeof liveFrame>;

export const roundLive = z.object({
  /** The story origin the urls resolve against, for the listener the page came through; null when the console serves none. */
  origin: z.string().nullable(),
  /** One entry per story variant, by variant key: a url relative to the story origin, or why it shows its PNG. */
  frames: z.record(z.string(), liveFrame),
});
export type RoundLive = z.infer<typeof roundLive>;

/** One line per file, sorted by path, so the id names the bytes alone and never when or where they were built. */
export function buildIdOf(files: readonly BuildFile[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => `${file.sha256} ${file.bytes} ${file.path}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

const pathProblem = (rel: string): string | undefined =>
  rel.split("/").every((segment) => PATH_SEGMENT.test(segment)) ? undefined : `file "${rel}" is not a plain relative path`;

/** Why the store must refuse this file list, or empty. */
export function buildListProblems(files: readonly BuildFile[]): string[] {
  if (files.length > MAX_BUILD_FILES) return [`the build lists over ${MAX_BUILD_FILES} files`];
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const paths = new Set(files.map((file) => file.path));
  return [
    ...(total > MAX_BUILD_BYTES ? [`the build is over ${MAX_BUILD_BYTES} bytes`] : []),
    ...files.flatMap((file) => pathProblem(file.path) ?? []),
    ...(paths.size === files.length ? [] : ["the build lists one path twice"]),
    ...[IFRAME_FILE, INDEX_FILE].filter((name) => !paths.has(name)).map((name) => `the build has no ${name}`),
  ];
}

/** The story ids a parsed `index.json` lists, or null when it is not a Storybook index. */
export function indexedStories(json: unknown): Set<string> | null {
  const parsed = StoryIndexSchema.safeParse(json);
  if (!parsed.success) return null;
  return new Set(Object.entries(parsed.data.entries).flatMap(([id, entry]) => (entry.type === "story" ? [id] : [])));
}

const sha7 = (sha: string): string => sha.slice(0, 7);

/** The heads a variant's build must be at: its section's PR group, else the round's merge-bound Ship heads, else none. */
function pinnedHeads(manifest: Manifest, key: string): string[] {
  const section = manifest.sections.find((candidate) => candidate.variantKeys.includes(key));
  const group = section && manifest.prGroups?.find((candidate) => candidate.sectionIds.includes(section.id));
  if (group) return [group.headSha];
  return manifest.questions.flatMap((question) => (question.kind === "pick-one" && question.merge ? [question.merge.headSha] : []));
}

type Pinned<B> = { pinned: B } | { reason: string };

/** CI builds the merge ref, so a round that records its build also accepts that merge sha. */
function pinOnly<B extends { build: { sha: string } }>(manifest: Manifest, heads: string[], only: B): Pinned<B> {
  const { sha } = only.build;
  if (heads.length === 0 || heads.includes(sha) || sha === manifest.build?.mergeSha) return { pinned: only };
  return { reason: `Live build is for ${sha7(sha)}; this round is at ${heads.map(sha7).join(", ")}` };
}

/**
 * The build a variant shows live. A round with one build keeps the single-build rule. With several, a variant takes
 * only the build at its own group's head: `build.mergeSha` is one round-wide sha, so it pins no group's build.
 */
export function pinnedBuild<B extends { build: { sha: string } }>(manifest: Manifest, key: string, builds: readonly B[]): Pinned<B> {
  const heads = pinnedHeads(manifest, key);
  const [only, ...others] = builds;
  if (only !== undefined && others.length === 0) return pinOnly(manifest, heads, only);
  const own = builds.find(({ build }) => heads.includes(build.sha));
  if (own !== undefined) return { pinned: own };
  if (heads.length === 0) return { reason: `This round carries ${builds.length} Storybook builds and this variant is in no PR group` };
  return { reason: `No live build for ${heads.map(sha7).join(", ")}; this round's builds are for ${builds.map(({ build }) => sha7(build.sha)).join(", ")}` };
}

type ArgMap = Record<string, string | number | boolean>;
export type Theme = (typeof THEME_MODES)[number];

// Storybook drops URL arg keys and values outside these (docs: writing-stories/args).
const URL_SAFE_VALUE = /^[A-Za-z0-9 _-]*$/;
const URL_SAFE_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const URL_SAFE_KEY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const encodeValue = (value: string | number | boolean): string => (typeof value === "boolean" ? `!${value}` : String(value));

const encodeArgMap = (map: ArgMap): string =>
  Object.entries(map)
    .map(([key, value]) => `${key}:${encodeValue(value)}`)
    .join(";");

function argMapProblems(where: string, map: ArgMap | undefined): string[] {
  return Object.entries(map ?? {}).flatMap(([key, value]) => {
    const problems: string[] = [];
    if (!URL_SAFE_KEY.test(key)) problems.push(`${where} key "${key}"`);
    const text = String(value);
    if (typeof value === "string" && !URL_SAFE_VALUE.test(text) && !URL_SAFE_NUMBER.test(text)) problems.push(`${where}.${key} = "${text}"`);
    return problems;
  });
}

interface StoryVariant {
  storyId: string;
  args?: ArgMap;
  globals?: ArgMap;
}

/** Args Storybook would silently strip from the URL; such a variant shows its PNG. */
const urlParamProblems = (variant: StoryVariant): string[] => [...argMapProblems("args", variant.args), ...argMapProblems("globals", variant.globals)];

function storyUrl(base: string, variant: StoryVariant): string {
  const params = new URLSearchParams({ id: variant.storyId, viewMode: "story", shortcuts: "false", singleStory: "true" });
  if (variant.args) params.set("args", encodeArgMap(variant.args));
  if (variant.globals) params.set("globals", encodeArgMap(variant.globals));
  return `${base.replace(/\/$/, "")}/${IFRAME_FILE}?${params.toString()}`;
}

/** A frames.json record's theme drives `withThemeByClassName`, so the live frame matches the PNG beside it. */
const withTheme = (globals: ArgMap | undefined, theme: Theme | undefined): ArgMap | undefined =>
  theme === undefined || globals?.theme !== undefined ? globals : { ...globals, theme };

/** `stories` is the build's indexed story ids, or why its stored `index.json` could not be read. */
export interface LiveBuild {
  build: StorybookBuild;
  buildId: string;
  stories: ReadonlySet<string> | string;
}

interface LiveInput {
  manifest: Manifest;
  builds: readonly LiveBuild[];
  themes: ReadonlyMap<string, Theme>;
}

function liveFrameOf({ manifest, builds, themes }: LiveInput, variant: Manifest["variants"][number] & StoryVariant): LiveFrame {
  const pin = pinnedBuild(manifest, variant.key, builds);
  if ("reason" in pin) return { reason: pin.reason };
  const { build, buildId, stories } = pin.pinned;
  if (typeof stories === "string") return { reason: stories };
  if (!stories.has(variant.storyId)) return { reason: `unknown story ${variant.storyId}: the build's index.json does not list it` };
  const unsafe = urlParamProblems(variant);
  if (unsafe.length > 0) return { reason: `unsafe args: ${unsafe.join("; ")}` };
  const globals = withTheme(variant.globals, themes.get(variant.key));
  const url = storyUrl(`/sb/${buildId}`, { ...variant, ...(globals !== undefined && { globals }) });
  return { url, buildSha: build.sha, ...(build.dirty && { dirty: true as const }) };
}

const isStory = (variant: Manifest["variants"][number]): variant is Manifest["variants"][number] & StoryVariant => variant.storyId !== undefined;

export function liveFrames(input: LiveInput): Record<string, LiveFrame> {
  return Object.fromEntries(input.manifest.variants.filter(isStory).map((variant) => [variant.key, liveFrameOf(input, variant)]));
}

/** Every story variant shows its PNG for one reason, such as a sidecar or stored build that cannot be read. */
export const unavailableFrames = (manifest: Manifest, reason: string): Record<string, LiveFrame> =>
  Object.fromEntries(manifest.variants.filter(isStory).map((variant) => [variant.key, { reason }]));

export const hasStoryVariants = (manifest: Manifest): boolean => manifest.variants.some(isStory);
