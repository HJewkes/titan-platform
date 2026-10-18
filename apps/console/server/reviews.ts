/**
 * The repo reviews the Reviews tab lists: one folder per review under the reviews dir, each with
 * a README.md. Another process writes the dir and it holds tens of thousands of files, so the
 * scan reads one level and then fixed paths per review, never walking. Every file opens through
 * `O_NOFOLLOW` and `O_NONBLOCK` up to a cap, every dir on the way is lstat'ed so a symlinked one
 * is refused, and a label must be a plain name before it becomes a path. Parsing is pm's;
 * the state is `review-rules.ts`'s. A file that fails to read or parse is a gap line, never a
 * hidden review. Parsed files are cached by mtime and size, so a refresh re-reads only what changed.
 */
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseClaimsAudit, parseTopicsJudged, readReviewPin, sumRunCost, type ReviewPin, type RunCost, type TopicRow } from "@titan-design/pm";
import { readCommand } from "./owner-guard.js";
import {
  CLAIMS_FILE, COUNTED_PRIORITIES, FLAT_LABEL, REVIEW_FILES, REVIEW_LABEL, REVIEW_NAME, REVIEW_STATES, SYNTHESIS_DIR, TOPICS_FILE, WAVE_STATE,
  coverageUnread, reviewState,
} from "./review-rules.js";
import { OPEN_FLAGS, readCapped } from "./rounds.js";

export interface ReviewsSource {
  dir: string;
}

const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_LABEL_BYTES = 256;
/** The list stops here, so a dir full of junk cannot make one read unbounded. */
const MAX_REVIEWS = 500;

const runCost = z.object({ usd: z.number(), calls: z.number(), errors: z.number(), lastTs: z.string().nullable() });

const reviewSummary = z.object({
  name: z.string(),
  remote: z.string().nullable(),
  head: z.string().nullable(),
  /** The README's own status line, shown dimmed; the state never comes from it. */
  readmeStatus: z.string().nullable(),
  /** `final`, `wave1` and the like, `flat` for TSVs directly in synthesis/, null when there is no synthesis to read. */
  label: z.string().nullable(),
  state: z.enum(REVIEW_STATES),
  p1: z.number(),
  p2: z.number(),
  topics: z.number(),
  claims: z.number(),
  unread: z.number().nullable(),
  cost: runCost.nullable(),
});

const reviewsListResult = z.object({ reviews: z.array(reviewSummary), gaps: z.array(z.string()), readAt: z.string() });
export type ReviewSummary = z.infer<typeof reviewSummary>;
export type ReviewsList = z.infer<typeof reviewsListResult>;

interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}
type CacheSlot<T> = Map<string, CacheEntry<T>>;

/** One slot per artifact, so each cached value keeps the type its parser gave it. */
interface ReviewFileCache {
  pin: CacheSlot<ReviewPin>;
  label: CacheSlot<string>;
  topics: CacheSlot<TopicRow[]>;
  claims: CacheSlot<number>;
  unread: CacheSlot<number | null>;
  cost: CacheSlot<RunCost>;
}

export const newReviewFileCache = (): ReviewFileCache => ({
  pin: new Map(), label: new Map(), topics: new Map(), claims: new Map(), unread: new Map(), cost: new Map(),
});

type FileRead<T> = { state: "absent" } | { state: "refused"; gap: string } | { state: "read"; value: T };

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

async function openReviewFile(file: string, rel: string): Promise<FileHandle | FileRead<never>> {
  try {
    return await open(file, OPEN_FLAGS);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return { state: "absent" };
    return { state: "refused", gap: code === "ELOOP" ? `${rel} is a symlink, not read` : `${rel} could not be read` };
  }
}

/** A cached value is reused while the file's mtime and size hold; a parser's error names `rel` and becomes the gap. */
async function readReviewFile<T>(cache: CacheSlot<T>, root: string, rel: string, cap: number, parse: (text: string) => T): Promise<FileRead<T>> {
  const file = path.join(root, rel);
  const handle = await openReviewFile(file, rel);
  if (!("stat" in handle)) return handle;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { state: "refused", gap: `${rel} is not a regular file` };
    const hit = cache.get(file);
    if (hit !== undefined && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) return { state: "read", value: hit.value };
    const bytes = stats.size > cap ? null : await readCapped(handle, cap);
    if (bytes === null) return { state: "refused", gap: `${rel} is over ${cap} bytes` };
    const value = parse(bytes.toString("utf8"));
    cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    return { state: "read", value };
  } catch (error) {
    return { state: "refused", gap: error instanceof Error && error.message.startsWith(rel) ? error.message : `${rel} could not be read` };
  } finally {
    await handle.close();
  }
}

const isRealDir = async (dir: string): Promise<boolean> => (await lstat(dir).catch(() => null))?.isDirectory() ?? false;

/** Where the review's TSVs sit, relative to its root: `synthesis/<label>/`, or `synthesis/` itself when flat. */
async function resolveLabel(cache: ReviewFileCache, root: string, gaps: string[]): Promise<{ label: string; dir: string } | null> {
  if (!(await isRealDir(path.join(root, SYNTHESIS_DIR)))) return null;
  const read = await readReviewFile(cache.label, root, REVIEW_FILES.label, MAX_LABEL_BYTES, (text) => text.trim());
  if (read.state === "absent") return { label: FLAT_LABEL, dir: SYNTHESIS_DIR };
  const dir = read.state === "read" && REVIEW_LABEL.test(read.value) ? path.posix.join(SYNTHESIS_DIR, read.value) : null;
  let gap: string;
  if (read.state === "refused") gap = read.gap;
  else if (dir === null) gap = `${REVIEW_FILES.label} is not a plain name; its TSVs were not read`;
  else if (!(await isRealDir(path.join(root, dir)))) gap = `${dir} is not a directory`;
  else return { label: read.value, dir };
  gaps.push(gap);
  return null;
}

/** The value read, or undefined when the file is absent or refused, a refusal adding its gap. */
function valueOf<T>(read: FileRead<T>, gaps: string[]): T | undefined {
  if (read.state === "refused") gaps.push(read.gap);
  return read.state === "read" ? read.value : undefined;
}

async function hasWaveState(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && WAVE_STATE.test(entry.name));
}

interface ReviewArtifacts {
  pin: ReviewPin;
  label: string | null;
  topics: TopicRow[] | undefined;
  claims: number | undefined;
  unread: number | null | undefined;
  cost: RunCost | undefined;
  waveState: boolean;
}

async function readArtifacts(cache: ReviewFileCache, root: string, pin: ReviewPin, gaps: string[]): Promise<ReviewArtifacts> {
  const read = <T>(slot: CacheSlot<T>, rel: string, parse: (text: string) => T) => readReviewFile(slot, root, rel, MAX_REVIEW_FILE_BYTES, parse);
  const synthesis = await resolveLabel(cache, root, gaps);
  const topicsRel = synthesis && path.posix.join(synthesis.dir, TOPICS_FILE);
  const claimsRel = synthesis && path.posix.join(synthesis.dir, CLAIMS_FILE);
  const [topics, claims, summary, runs, waveState] = await Promise.all([
    topicsRel ? read(cache.topics, topicsRel, (text) => parseTopicsJudged(text, topicsRel)) : ({ state: "absent" } as const),
    claimsRel ? read(cache.claims, claimsRel, (text) => parseClaimsAudit(text, claimsRel).length) : ({ state: "absent" } as const),
    read(cache.unread, REVIEW_FILES.summary, coverageUnread),
    read(cache.cost, REVIEW_FILES.runs, (text) => sumRunCost(text, REVIEW_FILES.runs)),
    hasWaveState(root),
  ]);
  const values = { topics: valueOf(topics, gaps), claims: valueOf(claims, gaps), unread: valueOf(summary, gaps), cost: valueOf(runs, gaps) };
  return { pin, label: synthesis?.label ?? null, ...values, waveState };
}

function summaryOf(name: string, artifacts: ReviewArtifacts): ReviewSummary {
  const { pin, label, topics = [], claims, unread, cost, waveState } = artifacts;
  const facts = { label, hasClaims: claims !== undefined, hasWaveState: waveState, hasSummary: unread !== undefined, unread: unread ?? null };
  const [p1, p2] = COUNTED_PRIORITIES.map((priority) => topics.filter((topic) => topic.priority === priority).length);
  return {
    name, remote: pin.remote ?? null, head: pin.head ?? null, readmeStatus: pin.status ?? null, label, state: reviewState(facts),
    p1: p1 ?? 0, p2: p2 ?? 0, topics: topics.length, claims: claims ?? 0, unread: unread ?? null, cost: cost ?? null,
  };
}

/** A dir with no README is not a review, so it yields nothing; one whose README is refused yields only its gap. */
async function loadReview(cache: ReviewFileCache, dir: string, name: string): Promise<{ review?: ReviewSummary; gaps: string[] }> {
  const root = path.join(dir, name);
  const gaps: string[] = [];
  const pin = valueOf(await readReviewFile(cache.pin, root, REVIEW_FILES.readme, MAX_REVIEW_FILE_BYTES, readReviewPin), gaps);
  if (pin === undefined) return { gaps: gaps.map((gap) => `${name}: ${gap}`) };
  const review = summaryOf(name, await readArtifacts(cache, root, pin, gaps));
  return { review, gaps: gaps.map((gap) => `${name}: ${gap}`) };
}

const newestFirst = (a: ReviewSummary, b: ReviewSummary): number =>
  (b.cost?.lastTs ?? "").localeCompare(a.cost?.lastTs ?? "") || a.name.localeCompare(b.name);

/** Nothing here throws: the dir itself, a review or a file that cannot be read is a gap line. */
export async function listReviews({ dir }: ReviewsSource, cache: ReviewFileCache = newReviewFileCache()): Promise<ReviewsList> {
  const readAt = new Date().toISOString();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { reviews: [], gaps: [errnoOf(error) === "ENOENT" ? "the reviews dir does not exist" : "the reviews dir could not be read"], readAt };
  }
  const names = entries.filter((entry) => entry.isDirectory() && REVIEW_NAME.test(entry.name)).map((entry) => entry.name).sort();
  const loaded = await Promise.all(names.slice(0, MAX_REVIEWS).map((name) => loadReview(cache, dir, name)));
  const gaps = loaded.flatMap((entry) => entry.gaps);
  if (names.length > MAX_REVIEWS) gaps.push(`only the first ${MAX_REVIEWS} of ${names.length} folders were read`);
  const reviews = loaded.flatMap(({ review }) => (review === undefined ? [] : [review])).sort(newestFirst);
  return { reviews, gaps, readAt };
}

export function reviewsCommands(source: ReviewsSource) {
  const cache = newReviewFileCache();
  return {
    "reviews.list": readCommand({
      name: "reviews.list",
      description: "Every repo review under the reviews dir with its state, label, P1 and P2 counts, claims, coverage and headless cost",
      args: z.object({}),
      result: reviewsListResult,
      run: () => listReviews(source, cache),
    }),
  };
}
