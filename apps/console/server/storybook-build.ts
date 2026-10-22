/**
 * A round's static Storybook build (TP-3793): the storybook@1 sidecar a round carries at
 * `storybook/storybook.json`, the content-hash id the store files it under, and the checks that
 * decide which of the round's story variants may show live. Everything here is pure; the copy is
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
export const STORYBOOK_STATIC = "static";
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
export const StorybookBuildSchema = z.object({
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

/** CI builds the merge ref, so a round that records its build also accepts that merge sha. */
export function pinReason(manifest: Manifest, key: string, buildSha: string): string | undefined {
  const heads = pinnedHeads(manifest, key);
  if (heads.length === 0 || heads.includes(buildSha) || buildSha === manifest.build?.mergeSha) return undefined;
  return `Live build is for ${sha7(buildSha)}; this round is at ${heads.map(sha7).join(", ")}`;
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

interface LiveInput {
  manifest: Manifest;
  build: StorybookBuild;
  buildId: string;
  stories: ReadonlySet<string>;
  themes: ReadonlyMap<string, Theme>;
}

function liveFrameOf({ manifest, build, buildId, stories, themes }: LiveInput, variant: Manifest["variants"][number] & StoryVariant): LiveFrame {
  const pinned = pinReason(manifest, variant.key, build.sha);
  if (pinned !== undefined) return { reason: pinned };
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
