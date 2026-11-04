import type { StepRunOutcome } from "@titan-design/workflow";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { L0Result } from "../eval-l0.js";
import { stampLedgerTerms } from "../ledger-stamp.js";
import { loadProfiles, profileFor } from "../profile-load.js";
import { chapterScopedChecks, shippedRuleRegistry } from "../rules.js";
import { wordBudgetFaults } from "../script-budget.js";
import { draftFillFaults, fillRows } from "../script-fill.js";
import type { ScriptBeat, ScriptChapter, ScriptV1 } from "../script-schema.js";
import type { SpineV1 } from "../spine-schema.js";
import {
  checkedObject, draftScript, factsSection, failingErrors, failureList, REPLY_RULES, repairPrompt, repairRounds, retimeRepaired, stageUsage,
  type Call, type Checked, type Lint, type Reader, type Repaired, type ScriptPlan, type Written,
} from "./script-draft.js";
import { patchTargets, patchTask, splicePatch } from "./chapter-patch.js";
import { factPlaces, factsSlice, type FactPlaces } from "./script-facts.js";
import { replyObject } from "./script-reply.js";
import { StageFailure } from "./stage-failure.js";
import { addUsage, NO_USAGE, type StageUsage } from "./records.js";

/**
 * A spine past either bound is drafted one chapter per call. On the two dev cases, an 11-chapter spine whose ledger
 * names about 70 beats drafted in one call at 19-24 failing error rows, and no repair round moved it; a 6-chapter,
 * 21-beat spine went from 10 rows to 0. Both bounds sit between the two.
 */
export const CHUNK_OVER_CHAPTERS = 8;
const CHUNK_OVER_BEATS = 40;
/** As many rounds per chapter as the single-call path gives the whole script; a chapter's reply is a tenth the size. */
const CHAPTER_REPAIR_ROUNDS = 2;
/** The joined script's one round, for what the chapter rounds left: its reply names only the beats it changes. */
const VIDEO_REPAIR_ROUNDS = 1;

/** The beats the spine plans: each beat its ledger defines or reuses an item in, less chapter ids. */
function plannedBeats(spine: SpineV1): number {
  const chapters = new Set(spine.chapters.map((row) => row.chapter));
  const named = spine.ledger.flatMap((row) => [row.definedIn, ...row.reusedIn]);
  return new Set(named.filter((id) => !chapters.has(id))).size;
}

export const isChunked = (spine: SpineV1): boolean =>
  spine.chapters.length > 1 && (spine.chapters.length > CHUNK_OVER_CHAPTERS || plannedBeats(spine) > CHUNK_OVER_BEATS);

interface ChunkContext {
  /** A call sending `system` as its own system prompt block, which the CLI caches, ahead of the call's prompt. */
  callFor: (system: string) => Call;
  /** The single-call prompt's sections less its facts and task: every call's system prompt, byte for byte the same. */
  shared: readonly string[];
  spineText: string;
  /** The whole facts pack: each chapter call gets its own slice, the whole-video round all of it. */
  facts: string;
  plan: ScriptPlan;
  lint: Lint;
  /** What the run has left; the chunked path makes many calls, so it stops itself here. */
  capUsd: number;
}

interface Chunk extends Pick<ChunkContext, "facts" | "plan" | "lint"> {
  call: Call;
  places: FactPlaces;
  spent: () => StageUsage;
}

/** The chapters written so far; the first chapter's reply holds the header and the video fields every chapter shares. */
interface Joined {
  header: ScriptV1;
  chapters: ScriptChapter[];
  beats: ScriptBeat[];
}

type Video = ScriptV1["video"];
type Glossary = Video["glossary"];

const nameKey = (entry: unknown): string | undefined => (isRecord(entry) && typeof entry.name === "string" ? entry.name.toLowerCase() : undefined);

function addGlossary<T>(glossary: Glossary, added: readonly T[]): (Glossary[number] | T)[] {
  const known = new Set(glossary.map(nameKey));
  return [...glossary, ...added.filter((entry) => !known.has(nameKey(entry)))];
}

function withPart(joined: Joined | undefined, part: ScriptV1): Joined {
  if (!joined) return { header: part, chapters: part.chapters, beats: part.beats };
  const video = { ...joined.header.video, glossary: addGlossary(joined.header.video.glossary, part.video.glossary) };
  return { header: { ...joined.header, video }, chapters: [...joined.chapters, ...part.chapters], beats: [...joined.beats, ...part.beats] };
}

/** The script so far, the spine's unwritten chapters as bare entries so position-read rules see the video's shape. */
function render(joined: Joined, spine: SpineV1): ScriptV1 {
  const written = new Set(joined.chapters.map((chapter) => chapter.id));
  const rest = spine.chapters.filter((row) => !written.has(row.chapter)).map((row) => ({ id: row.chapter, label: row.chapter, question: row.question }));
  const ids = new Set(joined.beats.map((beat) => beat.id));
  const video = { ...joined.header.video };
  if (!(video.thesis_refs ?? []).every((ref) => ids.has(ref))) delete video.thesis_refs;
  return { ...joined.header, video, chapters: [...joined.chapters, ...rest], beats: joined.beats };
}

function readRecord(outcome: StepRunOutcome): { raw: Record<string, unknown> } | { error: string } {
  if (!outcome.ok) return { error: outcome.error };
  try {
    const raw = replyObject(outcome.output);
    return isRecord(raw) ? { raw } : { error: "the reply holds no JSON object" };
  } catch {
    return { error: "the reply holds no JSON object" };
  }
}

/** A later chapter's video is the shared one plus the glossary entries its reply adds. */
function sharedVideo(video: Video, reply: unknown): Record<string, unknown> {
  const shared: Partial<Video> = { ...video };
  delete shared.thesis_refs;
  const added: unknown[] = isRecord(reply) && Array.isArray(reply.glossary) ? reply.glossary : [];
  return { ...shared, glossary: addGlossary(video.glossary, added) };
}

/** The first chapter names thesis beats the later chapters write, so its refs wait out the parse and the join drops any missing. */
function takeRefs(raw: Record<string, unknown>): string[] | undefined {
  if (!isRecord(raw.video)) return undefined;
  const refs = raw.video.thesis_refs;
  delete raw.video.thesis_refs;
  return Array.isArray(refs) && refs.length === 3 && refs.every((ref) => typeof ref === "string") ? refs : undefined;
}

function partFault(part: ScriptV1, id: string, joined: Joined | undefined): string | undefined {
  const ids = part.chapters.map((chapter) => chapter.id);
  if (ids.length !== 1 || ids[0] !== id) return `chapters: the reply must hold only chapter ${id}; it holds ${ids.join(", ")}`;
  const taken = new Set((joined?.beats ?? []).map((beat) => beat.id));
  const reused = part.beats.filter((beat) => taken.has(beat.id)).map((beat) => beat.id);
  return reused.length > 0 ? `beats: ${reused.join(", ")} already exist in an earlier chapter; give this chapter's beats new ids` : undefined;
}

/** A chapter reply as a one-chapter script, checked like a whole one against that chapter's lead beat. */
function chapterReply(outcome: StepRunOutcome, id: string, joined: Joined | undefined, plan: ScriptPlan): Checked {
  const read = readRecord(outcome);
  return "error" in read ? read : chapterObject(read.raw, id, joined, plan);
}

/** A repair round's patch reply, spliced into the chapter it repairs and then checked like a whole chapter reply. */
function patchReply(outcome: StepRunOutcome, chapter: ScriptV1, targets: readonly string[], joined: Joined | undefined, plan: ScriptPlan): Checked {
  const read = readRecord(outcome);
  if ("error" in read) return read;
  const spliced = splicePatch(read.raw, chapter, targets);
  return "error" in spliced ? spliced : chapterObject(spliced.raw, chapter.chapters[0]!.id, joined, plan);
}

function chapterObject(raw: Record<string, unknown>, id: string, joined: Joined | undefined, plan: ScriptPlan): Checked {
  if (joined) raw.video = sharedVideo(joined.header.video, raw.video);
  const refs = takeRefs(raw);
  const result = checkedObject(raw, { ...plan, leads: plan.leads.filter((lead) => lead.chapter === id) });
  const fault = result.script ? partFault(result.script, id, joined) : undefined;
  if (fault) return { error: fault };
  return result.script && refs ? { ...result, script: { ...result.script, video: { ...result.script.video, thesis_refs: refs } } } : result;
}

const chapterReader = (ctx: Chunk, id: string, joined: Joined | undefined): Reader => ({
  check: (outcome) => chapterReply(outcome, id, joined, ctx.plan),
  faults: (script) => [...wordBudgetFaults(script), ...draftFillFaults(script)],
});

/** A chapter's own failing rows: chapter-scoped rules, cut to the beats (or the chapter) of `id`. */
function chapterRows(rows: readonly L0Result[], scoped: ReadonlySet<string>, script: ScriptV1, id: string): L0Result[] {
  const mine = new Set([id, ...script.beats.filter((beat) => beat.chapter === id).map((beat) => beat.id)]);
  return failingErrors(rows)
    .filter((row) => scoped.has(row.check_id))
    .flatMap((row) => {
      const beats = row.detail_beats.filter((beat) => mine.has(beat));
      const value = row.value === row.detail_beats.length ? beats.length : row.value;
      return beats.length > 0 ? [{ ...row, detail_beats: beats, value }] : [];
    });
}

const plannedS = (beats: readonly ScriptBeat[]): number => beats.reduce((sum, beat) => sum + beat.plannedS, 0);

function runtimeLine(joined: Joined, plan: ScriptPlan): string {
  const target = plan.profile ? ` of the video's ${profileFor(loadProfiles(), plan.profile).runtime.targetS} s target` : "";
  return `The beats so far plan ${plannedS(joined.beats)} s${target}.`;
}

function soFar(joined: Joined | undefined, plan: ScriptPlan): string[] {
  if (!joined) return [];
  const chapters = joined.chapters.map((c) => `${c.id} (${joined.beats.filter((b) => b.chapter === c.id).length} beats)`).join(", ");
  const last = joined.beats.at(-1);
  const names = [...new Set(joined.beats.flatMap((beat) => beat.new_terms))];
  return [
    `## Written so far

Chapters written: ${chapters}. ${runtimeLine(joined, plan)}
The last beat written: ${last?.id} (${last?.function}): "${last?.spoken}"
Names already declared in new_terms: ${names.join(", ") || "none"}.

The video fields every chapter shares:

\`\`\`json
${JSON.stringify(joined.header.video)}
\`\`\``,
  ];
}

function chapterTask(spine: SpineV1, index: number, joined: Joined | undefined): string {
  const row = spine.chapters[index]!;
  const next = spine.chapters[index + 1];
  const video = joined
    ? `- "video" holds only "glossary": entries for the names this chapter introduces that the shared glossary lacks. Every other video field stays as shared.`
    : `- "video" holds the fields for the whole video: the promise, stake, thesis and running example every chapter serves. Its glossary lists this chapter's names; later chapters add theirs.`;
  const handoff = next ? `- This chapter hands off to ${next.chapter} (${next.question}).` : "- This chapter closes the video.";
  return `## Task: chapter ${row.chapter}, ${index + 1} of ${spine.chapters.length}

Write only chapter ${row.chapter} of this video's script/v1 as one JSON object, and reply with that object only.
- "chapters" holds only ${row.chapter} (${row.question}), and "beats" only its beats, in the order the spine plans them, each with its function and plannedS. No beat id repeats one written so far.
${video}
${handoff}
${REPLY_RULES}`;
}

function chapterPrompt(ctx: Chunk, joined: Joined | undefined, index: number): string {
  const id = ctx.lint.spine.chapters[index]!.chapter;
  const facts = factsSection(factsSlice(ctx.facts, ctx.places, id), `, the rows chapter ${id} may cite`);
  return [facts, ...soFar(joined, ctx.plan), chapterTask(ctx.lint.spine, index, joined)].join("\n\n") + "\n";
}

interface ChapterResult {
  joined: Joined;
  retried: boolean;
  stripped: string[];
  /** The kept reply's dropped bad values, each note naming the chapter. */
  dropped: string[];
  /** The beats the re-time raised in the kept draft. */
  retimed: string[];
  before: number;
  after: number;
}

async function repairChapter(ctx: Chunk, prompt: string, joined: Joined | undefined, part: ScriptV1): Promise<Repaired> {
  const id = part.chapters[0]!.id;
  const scoped = chapterScopedChecks(shippedRuleRegistry());
  const lintScript = (candidate: ScriptV1) => render(withPart(joined, candidate), ctx.lint.spine);
  return repairRounds(ctx.call, { script: part, stamps: [] }, {
    rounds: CHAPTER_REPAIR_ROUNDS,
    failing: (candidate) => [...chapterRows(ctx.lint.rows(lintScript(candidate)), scoped, lintScript(candidate), id), ...fillRows(candidate)],
    prompt: (candidate, rows) => chapterRepairPrompt(prompt, candidate, rows, failureList(rows, shippedRuleRegistry(), lintScript(candidate), ctx.lint)),
    read: (outcome, current, rows) => {
      const targets = patchTargets(rows, current);
      return targets ? patchReply(outcome, current, targets, joined, ctx.plan) : chapterReply(outcome, id, joined, ctx.plan);
    },
    settle: (script) => ({ script, stamps: [] }),
    retry: (current, rows) => {
      const targets = patchTargets(rows, current);
      return targets && patchTask(targets);
    },
  });
}

/** The repair prompt shows the whole chapter; its reply re-emits only the named beats, or the chapter when a row names no beat. */
function chapterRepairPrompt(prompt: string, chapter: ScriptV1, rows: readonly L0Result[], failures: string): string {
  const targets = patchTargets(rows, chapter);
  return targets ? repairPrompt(prompt, chapter, failures, patchTask(targets)) : repairPrompt(prompt, chapter, failures);
}

/** One chapter: its draft call and one retry, then its repair rounds on the chapter-scoped rules. */
async function writeChapter(ctx: Chunk, joined: Joined | undefined, index: number): Promise<ChapterResult> {
  const id = ctx.lint.spine.chapters[index]!.chapter;
  const prompt = chapterPrompt(ctx, joined, index);
  const draft = await draftScript(ctx.call, prompt, chapterReader(ctx, id, joined));
  if (!draft.script) throw new StageFailure(`script: chapter ${id}: ${draft.error}`, ctx.spent(), draft.retried ? 1 : 0);
  const repaired = await repairChapter(ctx, prompt, joined, draft.script);
  const stripped = repaired.stripped ?? draft.stripped ?? [];
  const dropped = (repaired.dropped ?? draft.dropped ?? []).map((note) => `chapter ${id}: ${note}`);
  const { before, after } = repaired;
  return { joined: withPart(joined, repaired.script), retried: draft.retried, stripped, dropped, retimed: draft.retimed, before, after };
}

/** Each call is counted against the run's cap before it is made: the chunked path has many, the single-call path three. */
function metered(call: Call, capUsd: number, where: () => string): { call: Call; spent: () => StageUsage } {
  let spent = NO_USAGE;
  const guarded: Call = async (prompt, kind) => {
    if (spent.usd >= capUsd) throw new StageFailure(`script: the run's spend cap stopped the chunked draft at ${where()}`, spent);
    const outcome = await call(prompt, kind);
    spent = addUsage(spent, stageUsage(outcome.usage));
    return outcome;
  };
  return { call: guarded, spent: () => spent };
}

const VIDEO_TASK = `## Task: the joined script

The script below was written one chapter per call and joined. Fix what the checks under it name, and keep the rest.
Reply with one JSON object and nothing else: "beats" lists only the beats you change, each one whole and keeping its id and chapter; "video" holds only the video fields you change, and is left out when you change none. No beat is added or removed.`;

/** The joined script's repair reply, a patch: changed beats by id, and changed video fields. */
function patched(outcome: StepRunOutcome, current: ScriptV1, plan: ScriptPlan): Checked {
  const read = readRecord(outcome);
  if ("error" in read) return read;
  const { raw } = read;
  if (!Array.isArray(raw.beats)) return { error: 'the reply holds no "beats" array' };
  const changed = new Map(raw.beats.filter(isRecord).map((beat) => [beat.id, beat]));
  const unknown = [...changed.keys()].filter((id) => !current.beats.some((beat) => beat.id === id));
  if (unknown.length > 0) return { error: `the reply names beats the script lacks: ${unknown.join(", ")}` };
  const beats = current.beats.map((beat) => (changed.has(beat.id) ? { ...changed.get(beat.id), id: beat.id, chapter: beat.chapter } : beat));
  const video = isRecord(raw.video) ? { ...current.video, ...raw.video } : current.video;
  return checkedObject(structuredClone({ ...current, video, beats }), plan);
}

async function repairVideo(ctx: Chunk, script: ScriptV1): Promise<Repaired> {
  const { spine, rows } = ctx.lint;
  const task = [factsSection(ctx.facts), VIDEO_TASK].join("\n\n");
  const prompt = (current: ScriptV1, failing: readonly L0Result[]) => {
    const failures = failureList(failing, shippedRuleRegistry(), current, ctx.lint);
    return `${task}\n\n## The joined script\n\n\`\`\`json\n${JSON.stringify(current)}\n\`\`\`\n\n## Checks the script fails\n\n${failures}\n`;
  };
  return repairRounds(ctx.call, stampLedgerTerms(script, spine, rows), {
    rounds: VIDEO_REPAIR_ROUNDS,
    failing: (current) => [...failingErrors(rows(current)), ...fillRows(current)],
    prompt,
    read: (outcome, current) => patched(outcome, current, ctx.plan),
    settle: (current) => stampLedgerTerms(current, spine, rows),
  });
}

function joinedScript(ctx: Chunk, joined: Joined): ScriptV1 {
  const result = checkedObject(structuredClone(render(joined, ctx.lint.spine)), ctx.plan);
  if (!result.script) throw new StageFailure(`script: the joined chapters do not parse: ${result.error}`, ctx.spent());
  return result.script;
}

/** The calls, dollars and prompt-cache tokens spent between two readings of the meter. */
function spendSince(now: StageUsage, then: StageUsage): string {
  const cache = `cache ${now.cacheReadTokens - then.cacheReadTokens} read, ${(now.cacheWriteTokens ?? 0) - (then.cacheWriteTokens ?? 0)} written`;
  return `${now.calls - then.calls} call(s), $${(now.usd - then.usd).toFixed(4)}${now.costUnknown ? " (cost unknown)" : ""}, ${cache}`;
}

/**
 * The long-spine path: each chapter drafted in its own call with what is written so far, and repaired on the
 * chapter-scoped rules; then the chapters join and the whole-video rules get one repair round on the joined script.
 * Every call sends the shared sections as one system prompt, so the first chapter's draft writes them to the prompt
 * cache and each later call, made after it, reads them back instead of writing them again.
 */
export async function chunkedScript(context: ChunkContext): Promise<Written> {
  const progress: Progress = { at: "the first chapter", notes: [], start: NO_USAGE };
  const meter = metered(context.callFor(context.shared.join("\n\n") + "\n"), context.capUsd, () => progress.at);
  const { facts, plan, lint } = context;
  const ctx: Chunk = { facts, plan, lint, places: factPlaces(context.spineText, lint.spine, facts), call: meter.call, spent: meter.spent };
  try {
    return await writeAll(ctx, progress);
  } catch (error) {
    throw withNotes(error, progress, meter.spent());
  }
}

/** Where the chunked path is, and a note per part it finished. */
interface Progress {
  at: string;
  notes: string[];
  start: StageUsage;
}

async function writeAll(ctx: Chunk, progress: Progress): Promise<Written> {
  let joined: Joined | undefined;
  const chapters: ChapterResult[] = [];
  for (const [index, row] of ctx.lint.spine.chapters.entries()) {
    [progress.at, progress.start] = [`chapter ${row.chapter}`, ctx.spent()];
    const result = await writeChapter(ctx, joined, index);
    progress.notes.push(`chapter ${row.chapter}: ${spendSince(ctx.spent(), progress.start)}; ${result.before} -> ${result.after} failing chapter checks`);
    chapters.push(result);
    joined = result.joined;
  }
  [progress.at, progress.start] = ["the whole-video repair", ctx.spent()];
  const video = await repairVideo(ctx, joinedScript(ctx, joined!));
  progress.notes.push(`whole video: ${spendSince(ctx.spent(), progress.start)}; ${video.before} -> ${video.after} failing error checks`);
  const retimed = retimeRepaired(video.script, chapters.flatMap((chapter) => chapter.retimed));
  return written(chapters, { ...video, script: retimed.script }, ctx.spent(), progress.notes, retimed);
}

/** A failed run keeps no notes, so its failure names what each finished part, and the one it stopped in, spent and fixed. */
function withNotes(error: unknown, progress: Progress, spent: StageUsage): unknown {
  if (!(error instanceof StageFailure)) return error;
  const parts = [...progress.notes, `${progress.at} so far: ${spendSince(spent, progress.start)}`];
  return new StageFailure(`${error.message}; after ${parts.join("; ")}`, error.usage, error.retries, error.checks);
}

function written(chapters: readonly ChapterResult[], video: Repaired, usage: StageUsage, notes: string[], retimed: Pick<Written, "checks" | "notes">): Written {
  const sum = (key: "before" | "after") => chapters.reduce((total, chapter) => total + chapter[key], 0);
  const detail = `chunked by chapter: ${sum("before")} failing chapter checks before repair, ${sum("after")} after; whole video: ${video.before} failing error checks before its repair, ${video.after} after`;
  return {
    script: video.script,
    stamps: video.stamps,
    usage,
    retries: chapters.filter((chapter) => chapter.retried).length,
    stripped: [...chapters.flatMap((chapter) => chapter.stripped), ...(video.stripped ?? [])],
    checks: [{ name: "l0-repair", gate: false, pass: video.after === 0, detail }, ...retimed.checks],
    notes: [...notes, ...chapters.flatMap((chapter) => chapter.dropped), ...(video.dropped ?? []).map((note) => `whole video: ${note}`), ...retimed.notes],
  };
}
