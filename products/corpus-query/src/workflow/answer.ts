import type { Db } from "@titan-design/store-sqlite";
import type { WorkflowContext, WorkflowFn } from "@titan-design/workflow";
import {
  buildBatches,
  ConfirmVerdictSchema,
  prefixSha,
  ScreenVerdictSchema,
  type Batch,
  type Candidate,
  type ConfirmRow,
  type ConfirmVerdict,
  type ScreenVerdict,
  type ShownPassage,
} from "../judge/index.js";
import { listChapters } from "../index-corpus.js";
import type { MatchTerms } from "../match.js";
import { readPassage, retrieve } from "../retrieve.js";
import { compareStoryOrder } from "../story-order.js";
import type { ChapterMeta, Passage, QuerySpec } from "../types.js";
import { judgeBatch, type BatchJob, type StageJudge } from "./judge-batch.js";
import type { Models } from "./routes.js";
import type { CompileRecord } from "./compile.js";
import { costEntry, readJson, runPaths, writeJson, type BatchArtifact, type CostEntry, type RunPaths } from "./run-dir.js";
import { warmThenWave } from "./wave.js";

export interface AnswerConfig {
  db: Db;
  root: string;
  dataDir: string;
  spec: QuerySpec;
  prefixes: { screen: string; confirm: string };
  models: Models;
  /** Grow rounds after the first screen, stopping early at a fixed point. */
  rounds: number;
  concurrency: number;
  budgetUsd: number;
  batchTokens: number;
  window: number;
  /** The run that compiled the spec, whose call joins this run's cost report; absent when the spec was given. */
  compileRunId?: string;
}

export interface Coverage {
  retrieved: number;
  judged: number;
  voided: number;
  unjudged: string[];
  skipped: string[];
  /** Batches that carried a canary, and judge calls that mis-judged theirs. */
  canaries: { batches: number; misses: number };
}

/** A verified row with where it came from: the passage's display ref, its book and its story-order key. */
export type SourcedRow = ConfirmRow & { ref: string; book: string; order: ChapterMeta["order"] };

export interface Answer {
  runId: string;
  rounds: number;
  candidates: number;
  rows: SourcedRow[];
  coverage: { screen: Coverage; confirm: Coverage };
}

interface RunState {
  ctx: WorkflowContext;
  config: AnswerConfig;
  paths: RunPaths;
  spentUsd: number;
  passages: Map<string, Passage>;
}

/** Merge keeps wins and marks recaps "referenced earlier"; previews, losses and asides need no confirm call. */
const CONFIRMED_EVENTS: ReadonlySet<Candidate["event"]> = new Set(["won", "referenced"]);

const screenJudge = (models: Models): StageJudge<ScreenVerdict, Candidate> => ({
  stage: "screen", schema: ScreenVerdictSchema, judged: (v) => v.judged, items: (v) => v.candidates, model: models.screen, redoModel: models.redo,
});

const confirmJudge = (models: Models): StageJudge<ConfirmVerdict, ConfirmRow> => ({
  stage: "confirm", schema: ConfirmVerdictSchema, judged: (v) => v.judged, items: (v) => v.rows, model: models.confirm, redoModel: models.redo,
});

const shown = (state: RunState, passage: Passage): ShownPassage => ({ id: passage.id, ref: passage.ref, text: readPassage(state.config.db, state.config.root, passage).join("\n\n") });

/** Retrieval is deterministic, but recording it pins the passages a resumed run judges even if the index moved. */
async function retrieveRound(state: RunState, round: number, terms: MatchTerms): Promise<Passage[]> {
  const excludeIds = new Set(state.passages.keys());
  const step = await state.ctx.seed(round === 0 ? "retrieve:r0" : `grow:r${round}`, async () => ({ data: {}, output: JSON.stringify(retrieve(state.config.db, terms, { window: state.config.window, excludeIds }).passages) }));
  const passages = JSON.parse(step.output ?? "[]") as Passage[];
  for (const p of passages) state.passages.set(p.id, p);
  return passages;
}

async function runWave<V, T extends { id: string; quote: string }>(state: RunState, stepId: string, jobs: BatchJob[], judge: StageJudge<V, T>): Promise<BatchArtifact<T>[]> {
  const wave = await warmThenWave(state.ctx, stepId, jobs, (job, itemStepId, ctx) => judgeBatch(ctx, itemStepId, job, judge), {
    key: (job) => job.batch.key, concurrency: state.config.concurrency, budgetUsd: state.config.budgetUsd - state.spentUsd,
  });
  state.spentUsd += wave.spentUsd;
  const collected = await state.ctx.seed(`${stepId}/collect`, async () => {
    const missing = jobs.filter((job) => readJson(job.file) === undefined).map((job) => job.batch.key);
    return { data: {}, output: JSON.stringify({ expected: jobs.length, missing, stoppedBy: wave.stoppedBy }) };
  });
  const missing = new Set((JSON.parse(collected.output ?? "{}") as { missing?: string[] }).missing ?? []);
  return jobs.filter((job) => !missing.has(job.batch.key)).map((job) => readJson<BatchArtifact<T>>(job.file)!);
}

/**
 * Names on `won` candidates only: a run's previews, recaps and asides name every team and person in the corpus, and
 * growing from them retrieved more passages than the first round.
 */
function newNames(artifacts: readonly BatchArtifact<Candidate>[], lexicon: Set<string>): string[] {
  const fresh = new Map<string, string>();
  const won = artifacts.flatMap((a) => a.items.filter((c) => c.event === "won"));
  for (const name of won.flatMap((c) => [c.entity, ...c.names])) {
    const folded = name.trim().toLocaleLowerCase();
    if (folded.length > 0 && !lexicon.has(folded) && !fresh.has(folded)) fresh.set(folded, name.trim());
  }
  for (const folded of fresh.keys()) lexicon.add(folded);
  return [...fresh.values()];
}

function screenJobs(state: RunState, round: number, passages: Passage[], known: readonly string[]): BatchJob[] {
  const batches = buildBatches(passages.map((p) => shown(state, p)), {
    tokenBudget: state.config.batchTokens,
    prefixSha: prefixSha(state.config.prefixes.screen),
    canaries: state.config.spec.canaries,
    ...(known.length > 0 ? { preamble: `Names already known from earlier passages: ${known.join(", ")}` } : {}),
  });
  return batches.map((batch) => ({ batch, round, file: state.paths.batch("screen", batch.key, round) }));
}

/** A grown name stands in for the spec's first term group; the groups after it, what happened, still apply. */
function growTerms(spec: QuerySpec, grown: string[]): MatchTerms {
  return spec.termGroups.length > 1 ? { termGroups: [grown, ...spec.termGroups.slice(1)] } : { seedLexicon: grown };
}

/** Screen, then grow the lexicon from the names judges reported, until no name is new or the round cap is hit. */
async function screenRounds(state: RunState): Promise<{ rounds: number; jobs: BatchJob[]; artifacts: BatchArtifact<Candidate>[] }> {
  const { spec } = state.config;
  const lexicon = new Set(spec.seedLexicon.map((t) => t.toLocaleLowerCase()));
  const jobs: BatchJob[] = [];
  const artifacts: BatchArtifact<Candidate>[] = [];
  let terms: MatchTerms = { termGroups: spec.termGroups, phrases: spec.phrases, seedLexicon: spec.seedLexicon };
  let round = 0;
  for (; round <= state.config.rounds; round++) {
    const passages = await retrieveRound(state, round, terms);
    if (passages.length === 0) break;
    const roundJobs = screenJobs(state, round, passages, [...lexicon]);
    const found = await runWave(state, `screen:r${round}`, roundJobs, screenJudge(state.config.models));
    jobs.push(...roundJobs);
    artifacts.push(...found);
    const grown = newNames(found, lexicon);
    if (grown.length === 0) {
      round++;
      break;
    }
    terms = growTerms(spec, grown);
  }
  return { rounds: round, jobs, artifacts };
}

function sourced(state: RunState, rows: readonly ConfirmRow[]): SourcedRow[] {
  const chapters = new Map(listChapters(state.config.db).map((meta) => [meta.id, meta]));
  return rows.map((row) => {
    const passage = state.passages.get(row.id)!;
    const meta = chapters.get(passage.chapterId)!;
    return { ...row, ref: passage.ref, book: bookOf(meta), order: meta.order };
  });
}

function costReport(state: RunState, artifacts: readonly BatchArtifact<unknown>[]): CostEntry[] {
  const { compileRunId, dataDir } = state.config;
  const compiled = compileRunId === undefined ? undefined : readJson<CompileRecord>(runPaths(dataDir, compileRunId).compile);
  return [...(compiled?.usage ?? []).map((e) => costEntry("compile", e)), ...artifacts.flatMap((a) => a.usage.map((e) => costEntry(a.stage, e)))];
}

const bookOf = (meta: ChapterMeta): string => (meta.book === undefined ? meta.series : `${meta.series}/book_${String(meta.book).padStart(2, "0")}`);

/** One confirm call per book, holding all of that book's candidate passages, so cross-passage context is in one window. */
function confirmJobs(state: RunState, candidates: readonly Candidate[]): BatchJob[] {
  const chapters = new Map(listChapters(state.config.db).map((meta) => [meta.id, meta]));
  const byBook = new Map<string, Passage[]>();
  for (const id of new Set(candidates.map((c) => c.id))) {
    const passage = state.passages.get(id);
    if (!passage) continue;
    const book = bookOf(chapters.get(passage.chapterId)!);
    byBook.set(book, [...(byBook.get(book) ?? []), passage]);
  }
  const firstOrder = (ps: Passage[]) => chapters.get(ps[0]!.chapterId)!.order;
  const books = [...byBook].sort(([, a], [, b]) => compareStoryOrder(firstOrder(a), firstOrder(b)));
  return books.map(([book, passages]) => {
    const [batch] = buildBatches(passages.map((p) => shown(state, p)), {
      tokenBudget: Number.POSITIVE_INFINITY,
      prefixSha: prefixSha(state.config.prefixes.confirm),
      canaries: state.config.spec.canaries,
      preamble: `Book: ${book}`,
    });
    return { batch: batch as Batch, book, file: state.paths.batch("confirm", batch!.key) };
  });
}

function coverage<T>(jobs: readonly BatchJob[], artifacts: readonly BatchArtifact<T>[]): Coverage {
  const done = new Set(artifacts.map((a) => a.key));
  const retrieved = jobs.reduce((n, job) => n + job.batch.passages.length, 0);
  const unjudged = artifacts.flatMap((a) => a.unjudged);
  return {
    retrieved,
    judged: artifacts.reduce((n, a) => n + a.passageIds.length, 0) - unjudged.length,
    voided: artifacts.reduce((n, a) => n + a.voided.length, 0),
    unjudged,
    skipped: jobs.filter((job) => !done.has(job.batch.key)).flatMap((job) => job.batch.passages.map((p) => p.id)),
    canaries: { batches: jobs.filter((job) => job.batch.canary).length, misses: artifacts.reduce((n, a) => n + a.canaryMisses, 0) },
  };
}

/** The `cq-answer` run: screen and grow, confirm by book, then write the verified rows and their coverage. */
export function answerWorkflow(config: AnswerConfig): WorkflowFn {
  return async (ctx) => {
    const state: RunState = { ctx, config, paths: runPaths(config.dataDir, ctx.runId), spentUsd: 0, passages: new Map() };
    const screened = await screenRounds(state);
    const candidates = screened.artifacts.flatMap((a) => a.items.filter((c) => CONFIRMED_EVENTS.has(c.event)));
    const jobs = confirmJobs(state, candidates);
    const confirmed = await runWave(state, "confirm:books", jobs, confirmJudge(config.models));
    const answer: Answer = {
      runId: ctx.runId,
      rounds: screened.rounds,
      candidates: candidates.length,
      rows: sourced(state, confirmed.flatMap((a) => a.items)),
      coverage: { screen: coverage(screened.jobs, screened.artifacts), confirm: coverage(jobs, confirmed) },
    };
    writeJson(state.paths.answer, answer);
    writeJson(state.paths.cost, costReport(state, [...screened.artifacts, ...confirmed]));
  };
}
