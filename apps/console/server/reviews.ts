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
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import {
  parseClaimsAudit, parseTopicsJudged, readReviewPin, sumRunCost, summaryRecommendations,
  type ClaimRow, type ReviewItem, type ReviewPin, type RunCost, type TopicRow,
} from "@titan-design/pm";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import {
  CLAIMS_FILE, COUNTED_PRIORITIES, FLAT_LABEL, REVIEW_FILES, REVIEW_LABEL, REVIEW_NAME, REVIEW_STATES, SYNTHESIS_DIR, TOPICS_FILE, WAVE_STATE,
  coverageOf, reviewState,
} from "./review-rules.js";
import { OPEN_FLAGS, readCapped } from "./rounds.js";

export interface ReviewsSource {
  dir: string;
}

const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_LABEL_BYTES = 256;
/** The markdown `reviews.get` returns stops here; coverage and recommendations still read the whole file. */
const MAX_SUMMARY_MARKDOWN_BYTES = 256 * 1024;
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

const topicRow = z.object({
  topic_id: z.string(), tier: z.string(), title: z.string(), verdict: z.string(), priority: z.string(), titan_evidence: z.string(), reason: z.string(),
  line: z.number(), extra: z.record(z.string(), z.string()),
});

const claimRow = z.object({
  id: z.string(), source: z.string(), status: z.string(), evidence: z.string(), claim: z.string(), line: z.number(),
  basis: z.string().optional(), note: z.string().optional(), wave: z.string().optional(),
});

const recommendation = z.object({ id: z.string(), source: z.enum(["recommendation", "topic"]), line: z.number() });

const reviewDetailResult = z.object({
  review: reviewSummary,
  summary: z.object({ markdown: z.string(), truncated: z.boolean(), bytes: z.number() }).nullable(),
  coverage: z.string().nullable(),
  /** Null when the SUMMARY has no recommendations heading or there is no SUMMARY; a gap line says which. */
  recommendations: z.array(recommendation).nullable(),
  topics: z.array(topicRow),
  claims: z.array(claimRow),
  gaps: z.array(z.string()),
  readAt: z.string(),
});
type ReviewDetail = z.infer<typeof reviewDetailResult>;

/** What one read of SUMMARY.md yields; the list uses only the unread count. */
interface SummaryRead {
  markdown: string;
  truncated: boolean;
  bytes: number;
  coverage: { line: string; unread: number } | null;
  recommendations: ReviewItem[] | { gap: string };
}

/** Cuts at a byte cap without splitting a UTF-8 sequence: the decoder holds back a partial one. */
function capMarkdown(text: string): Pick<SummaryRead, "markdown" | "truncated" | "bytes"> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_SUMMARY_MARKDOWN_BYTES) return { markdown: text, truncated: false, bytes: bytes.length };
  return { markdown: new StringDecoder("utf8").write(bytes.subarray(0, MAX_SUMMARY_MARKDOWN_BYTES)), truncated: true, bytes: bytes.length };
}

function recommendationsOf(text: string): SummaryRead["recommendations"] {
  try {
    return summaryRecommendations(text);
  } catch (error) {
    return { gap: error instanceof Error ? error.message : `${REVIEW_FILES.summary} recommendations could not be read` };
  }
}

const parseSummary = (text: string): SummaryRead => ({ ...capMarkdown(text), coverage: coverageOf(text), recommendations: recommendationsOf(text) });

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
  claims: CacheSlot<ClaimRow[]>;
  summary: CacheSlot<SummaryRead>;
  cost: CacheSlot<RunCost>;
}

export const newReviewFileCache = (): ReviewFileCache => ({
  pin: new Map(), label: new Map(), topics: new Map(), claims: new Map(), summary: new Map(), cost: new Map(),
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
  claims: ClaimRow[] | undefined;
  summary: SummaryRead | undefined;
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
    claimsRel ? read(cache.claims, claimsRel, (text) => parseClaimsAudit(text, claimsRel)) : ({ state: "absent" } as const),
    read(cache.summary, REVIEW_FILES.summary, parseSummary),
    read(cache.cost, REVIEW_FILES.runs, (text) => sumRunCost(text, REVIEW_FILES.runs)),
    hasWaveState(root),
  ]);
  const values = { topics: valueOf(topics, gaps), claims: valueOf(claims, gaps), summary: valueOf(summary, gaps), cost: valueOf(runs, gaps) };
  return { pin, label: synthesis?.label ?? null, ...values, waveState };
}

function summaryOf(name: string, artifacts: ReviewArtifacts): ReviewSummary {
  const { pin, label, topics = [], claims, summary, cost, waveState } = artifacts;
  const unread = summary?.coverage?.unread ?? null;
  const facts = { label, hasClaims: claims !== undefined, hasWaveState: waveState, hasSummary: summary !== undefined, unread };
  const [p1, p2] = COUNTED_PRIORITIES.map((priority) => topics.filter((topic) => topic.priority === priority).length);
  return {
    name, remote: pin.remote ?? null, head: pin.head ?? null, readmeStatus: pin.status ?? null, label, state: reviewState(facts),
    p1: p1 ?? 0, p2: p2 ?? 0, topics: topics.length, claims: claims?.length ?? 0, unread, cost: cost ?? null,
  };
}

/** A dir with no README is not a review, so it yields no artifacts; one whose README is refused yields only its gap. */
async function loadArtifacts(cache: ReviewFileCache, dir: string, name: string): Promise<{ artifacts?: ReviewArtifacts; gaps: string[] }> {
  const root = path.join(dir, name);
  const gaps: string[] = [];
  const pin = valueOf(await readReviewFile(cache.pin, root, REVIEW_FILES.readme, MAX_REVIEW_FILE_BYTES, readReviewPin), gaps);
  if (pin === undefined) return { gaps };
  return { artifacts: await readArtifacts(cache, root, pin, gaps), gaps };
}

async function loadReview(cache: ReviewFileCache, dir: string, name: string): Promise<{ review?: ReviewSummary; gaps: string[] }> {
  const { artifacts, gaps } = await loadArtifacts(cache, dir, name);
  const named = gaps.map((gap) => `${name}: ${gap}`);
  return artifacts === undefined ? { gaps: named } : { review: summaryOf(name, artifacts), gaps: named };
}

/** The review folder names one level under the dir; `reviews.get` answers only a name from this set. */
async function scanNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && REVIEW_NAME.test(entry.name)).map((entry) => entry.name).sort();
}

const newestFirst = (a: ReviewSummary, b: ReviewSummary): number =>
  (b.cost?.lastTs ?? "").localeCompare(a.cost?.lastTs ?? "") || a.name.localeCompare(b.name);

const dirGap = (error: unknown): string => (errnoOf(error) === "ENOENT" ? "the reviews dir does not exist" : "the reviews dir could not be read");

/** Nothing here throws: the dir itself, a review or a file that cannot be read is a gap line. */
export async function listReviews({ dir }: ReviewsSource, cache: ReviewFileCache = newReviewFileCache()): Promise<ReviewsList> {
  const readAt = new Date().toISOString();
  let names;
  try {
    names = await scanNames(dir);
  } catch (error) {
    return { reviews: [], gaps: [dirGap(error)], readAt };
  }
  const loaded = await Promise.all(names.slice(0, MAX_REVIEWS).map((name) => loadReview(cache, dir, name)));
  const gaps = loaded.flatMap((entry) => entry.gaps);
  if (names.length > MAX_REVIEWS) gaps.push(`only the first ${MAX_REVIEWS} of ${names.length} folders were read`);
  const reviews = loaded.flatMap(({ review }) => (review === undefined ? [] : [review])).sort(newestFirst);
  return { reviews, gaps, readAt };
}

/** The refusal never echoes the name it was given, which may be a path. */
const notFound = (): Error => failure("NOT FOUND: no review by that name", EXIT.NOINPUT);

function detailOf(name: string, artifacts: ReviewArtifacts, gaps: string[]): Omit<ReviewDetail, "readAt"> {
  const { summary } = artifacts;
  let recommendations: ReviewItem[] | null = null;
  if (summary === undefined) gaps.push(`${REVIEW_FILES.summary} is absent; no recommendations`);
  else if (Array.isArray(summary.recommendations)) recommendations = summary.recommendations;
  else gaps.push(summary.recommendations.gap);
  return {
    review: summaryOf(name, artifacts),
    summary: summary === undefined ? null : { markdown: summary.markdown, truncated: summary.truncated, bytes: summary.bytes },
    coverage: summary?.coverage?.line ?? null, recommendations, topics: artifacts.topics ?? [], claims: artifacts.claims ?? [], gaps,
  };
}

/** One review in full. The name is looked up in the scanned set and never joined as given, so `../x` is NOT FOUND. */
export async function getReview({ dir }: ReviewsSource, name: string, cache: ReviewFileCache = newReviewFileCache()): Promise<ReviewDetail> {
  const readAt = new Date().toISOString();
  const names = await scanNames(dir).catch((error: unknown) => {
    throw failure(dirGap(error), EXIT.UNAVAILABLE);
  });
  const known = names.slice(0, MAX_REVIEWS).find((candidate) => candidate === name);
  if (known === undefined) throw notFound();
  const { artifacts, gaps } = await loadArtifacts(cache, dir, known);
  if (artifacts === undefined) throw notFound();
  return { ...detailOf(known, artifacts, gaps), readAt };
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
    "reviews.get": readCommand({
      name: "reviews.get",
      description: "One repo review: its summary markdown (capped), coverage line, recommendations or a gap line, every topic row and the claims rows",
      args: z.object({ name: z.string().min(1).max(100) }),
      result: reviewDetailResult,
      run: ({ name }) => getReview(source, name, cache),
    }),
  };
}
