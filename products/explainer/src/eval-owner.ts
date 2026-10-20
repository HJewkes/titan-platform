import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { chaptersOf, coldQuestions } from "./eval-cold.js";
import { deriveEvalView, type EvalBeat } from "./eval-view.js";
import { appendTsv, freezeScript, type BenchLayout } from "./eval-store.js";
import type { MapLayout } from "./map-state.js";
import type { PaceBeat } from "./pace-items.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function narrationCell(beat: ScriptBeat): string {
  const lines = [`**${beat.function}** ${beat.spoken}`];
  if (beat.why) lines.push(`_why:_ ${beat.why.need}; ${beat.why.actor} → ${beat.why.consequence}`);
  return lines.map(cell).join("<br>");
}

function mapSummary(beat: ScriptBeat, view: EvalBeat): string[] {
  const v = view.visual;
  if (v.mode === "none") return ["map: off screen"];
  const level = beat.visual.map_state?.level ?? "resumed";
  const lines = [`map: ${level} · here: ${v.you_are_here ?? "none"} · shows: ${v.nodes_shown.join(", ") || "none"}`];
  if (v.edges_shown.length > 0) lines.push(`edges: ${v.edges_shown.join(", ")}`);
  return lines;
}

function visualCell(beat: ScriptBeat, view: EvalBeat): string {
  const { visual } = beat;
  const lines = [`**${visual.assertion}**`, `job: ${visual.job}`, ...mapSummary(beat, view)];
  for (const change of view.visual.state_changes) lines.push(`on "${change.cue}": ${change.op} ${change.target}`);
  if (visual.labels.length > 0) lines.push(`labels: ${visual.labels.join(", ")}`);
  for (const chip of visual.chips) lines.push(`chip (${chip.kind}): ${chip.text}`);
  if (visual.code) lines.push(`code: ${visual.code.file}:${visual.code.lines.join("-")}`);
  return lines.map(cell).join("<br>");
}

/**
 * Renders a script as a storyboard: per beat, the narration track beside the visual track, with every
 * assertion and its `map_state` summary. It names the version only by `label`, never by script id or
 * sha, so the owner can read it blind.
 */
export function renderOwnerStoryboard(script: ScriptV1, label: string, layout?: MapLayout): string {
  const views = new Map(deriveEvalView(script, layout).map((view) => [view.id, view]));
  const out = [`# Version ${label}`, ""];
  for (const chapter of script.chapters) {
    out.push(`## ${chapter.label}`, "", `_${chapter.question}_`, "", "| Narration | Visual |", "|---|---|");
    for (const beat of script.beats.filter((b) => b.chapter === chapter.id)) {
      out.push(`| ${narrationCell(beat)} | ${visualCell(beat, views.get(beat.id)!)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** One version under blind review: the generator config that produced it and its script. */
export interface OwnerVersion {
  config_id: string;
  script: ScriptV1;
}

/** Which blind label hides which version. Sealed until the owner's rating is written. */
const BlindKeySchema = z.record(z.string(), z.object({ config_id: z.string(), script_sha: z.string() }).strict());
export type BlindKey = z.infer<typeof BlindKeySchema>;

export const OWNER_COLUMNS = [
  "date",
  "session",
  "held_out",
  "config_id",
  "script_sha",
  "scope",
  "item",
  "value",
  "note",
  "blind_key_ref",
] as const;

/** One owner answer, a row of `owner.tsv`. */
export interface OwnerRow {
  date: string;
  session: string;
  held_out: "y" | "n";
  config_id: string;
  script_sha: string;
  scope: string;
  item: string;
  value: string;
  note: string;
  blind_key_ref: string;
}

const SESSION_ID = /^[a-z0-9][a-z0-9-]*$/;
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SEALED = "key.sealed";
const OPENED = "key.json";

const ownerPath = (layout: BenchLayout): string => join(layout.evals, "owner.tsv");

/** A session's folder under `evals/owner/`, holding its storyboards and its key. */
export function ownerSessionDir(layout: BenchLayout, session: string): string {
  if (!SESSION_ID.test(session)) throw new Error(`session id "${session}" must be lowercase kebab-case`);
  return join(layout.evals, "owner", session);
}

function shuffled<T>(items: readonly T[], pick: (n: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Options for a blind session; `pick` returns an integer in [0, n) and defaults to a CSPRNG. */
export interface PrepareOptions {
  layout?: MapLayout;
  pick?: (n: number) => number;
}

/**
 * Prepares a blind owner session: freezes each version, writes one storyboard per shuffled label
 * and seals the key. The sealed key is an envelope, not a lock: it keeps the mapping out of plain
 * sight until `recordOwnerSession` opens it. Returns the labels in order.
 */
export function prepareOwnerSession(bench: BenchLayout, session: string, versions: readonly OwnerVersion[], options: PrepareOptions = {}): string[] {
  if (versions.length < 2 || versions.length > LABELS.length) throw new Error(`a blind session needs 2–${LABELS.length} versions`);
  const dir = ownerSessionDir(bench, session);
  if (existsSync(dir)) throw new Error(`owner session ${session} already exists`);
  mkdirSync(dir, { recursive: true });
  const key: BlindKey = {};
  shuffled(versions, options.pick ?? randomInt).forEach((version, i) => {
    const label = LABELS[i]!;
    key[label] = { config_id: version.config_id, script_sha: freezeScript(bench, version.script, version.script.parent_sha ?? null) };
    writeFileSync(join(dir, `storyboard-${label}.md`), renderOwnerStoryboard(version.script, label, options.layout));
  });
  writeFileSync(join(dir, SEALED), Buffer.from(JSON.stringify(key)).toString("base64"));
  return Object.keys(key);
}

/** One answer as the owner gives it: against a blind label, never a config. */
export interface OwnerAnswer {
  label: string;
  scope: string;
  item: string;
  value: string;
  note?: string;
}

export interface RecordOptions {
  date: string;
  heldOut: boolean;
}

function toRows(bench: BenchLayout, session: string, key: BlindKey, answers: readonly OwnerAnswer[], options: RecordOptions): OwnerRow[] {
  const blind_key_ref = relative(bench.evals, join(ownerSessionDir(bench, session), OPENED));
  return answers.map((answer) => {
    const version = key[answer.label];
    if (!version) throw new Error(`answer names label ${answer.label}, which session ${session} does not have`);
    const { scope, item, value } = answer;
    const held_out = options.heldOut ? "y" : "n";
    return { date: options.date, session, held_out, ...version, scope, item, value, note: answer.note ?? "", blind_key_ref };
  });
}

/**
 * Writes the owner's answers to `owner.tsv` and only then opens the key, so no rating is ever made
 * by someone who could already see which version was which. Returns the opened key.
 */
export function recordOwnerSession(bench: BenchLayout, session: string, answers: readonly OwnerAnswer[], options: RecordOptions): BlindKey {
  const dir = ownerSessionDir(bench, session);
  if (existsSync(join(dir, OPENED))) throw new Error(`owner session ${session} is already rated; its key is open`);
  if (answers.length === 0) throw new Error("a session with no answers cannot open its key");
  const sealed = Buffer.from(readFileSync(join(dir, SEALED), "utf8"), "base64").toString("utf8");
  const key = BlindKeySchema.parse(JSON.parse(sealed));
  appendTsv<OwnerRow>(ownerPath(bench), OWNER_COLUMNS, toRows(bench, session, key, answers, options));
  writeFileSync(join(dir, OPENED), `${JSON.stringify(key, null, 2)}\n`);
  return key;
}

/** The one label a timed session's key hides: a timed check rates a single version, not a blind pair. */
const TIMED_LABEL = "A";
export const OVERLOAD_ITEM = "overload";
const TIMED_SCOPE = "timed:";

/** The version a timed session rates. The caller hashes its own script, since spike scripts are not `script/v1`. */
export interface TimedVersion {
  config_id: string;
  script_sha: string;
}

/** The id a question's answer is filed under: the cold probe's kind plus its item, or its beat for a list. */
const questionId = (question: ReturnType<typeof coldQuestions>[number]): string =>
  question.kind === "odd-one-out" ? `${question.kind}:${question.beat}` : `${question.kind}:${question.item}`;

function chapterQuestionSheet(chapter: string, beats: readonly PaceBeat[]): string {
  const asked = coldQuestions(beats).map((q) => `- ${questionId(q)}: ${q.text}`);
  const scale = "Answer 0 (not stated), 1 (what it is) or 2 (what and why); an odd-one-out is the item or none.";
  const overload = `- ${OVERLOAD_ITEM}: How overloaded did this chapter feel, from 1 (easy to follow) to 5 (far too much)?`;
  return [`# Chapter ${chapter}`, "", scale, "", ...asked, overload, ""].join("\n");
}

/**
 * Prepares a timed human check: one `questions-<chapter>.md` per chapter, asking exactly what the cold probe
 * asks of the same item track, plus a 1-5 overload row. The version is sealed until the answers are written.
 * Returns the chapters in the order they are watched.
 */
export function prepareTimedSession(bench: BenchLayout, session: string, version: TimedVersion, beats: readonly PaceBeat[], chapters?: readonly string[]): string[] {
  const dir = ownerSessionDir(bench, session);
  if (existsSync(dir)) throw new Error(`owner session ${session} already exists`);
  const wanted = chaptersOf(beats).filter((c) => !chapters || chapters.includes(c.chapter));
  if (wanted.length === 0) throw new Error("a timed session needs at least one chapter with beats");
  mkdirSync(dir, { recursive: true });
  for (const { chapter, beats: chapterBeats } of wanted) writeFileSync(join(dir, `questions-${chapter}.md`), chapterQuestionSheet(chapter, chapterBeats));
  const key: BlindKey = { [TIMED_LABEL]: version };
  writeFileSync(join(dir, SEALED), Buffer.from(JSON.stringify(key)).toString("base64"));
  return wanted.map((c) => c.chapter);
}

/** One timed answer: a chapter, a question id from its sheet, and the value given. */
export interface TimedAnswer {
  chapter: string;
  item: string;
  value: string;
  note?: string;
}

const OVERLOAD_VALUES = ["1", "2", "3", "4", "5"];
const ITEM_VALUES = ["0", "1", "2"];
const isScored = (item: string): boolean => item.startsWith("what-why:") || item.startsWith("invariant:");

function checkTimedAnswer({ chapter, item, value }: TimedAnswer): void {
  const allowed = item === OVERLOAD_ITEM ? OVERLOAD_VALUES : isScored(item) ? ITEM_VALUES : null;
  if (allowed && !allowed.includes(value)) throw new Error(`${chapter} ${item}: "${value}" must be one of ${allowed.join(", ")}`);
}

/** Writes the timed answers to `owner.tsv` with scope `timed:<chapter>`, then opens the key, as a blind session does. */
export function recordTimedSession(bench: BenchLayout, session: string, answers: readonly TimedAnswer[], options: RecordOptions): BlindKey {
  answers.forEach(checkTimedAnswer);
  const owner = answers.map(({ chapter, item, value, note }): OwnerAnswer => ({ label: TIMED_LABEL, scope: `${TIMED_SCOPE}${chapter}`, item, value, note }));
  return recordOwnerSession(bench, session, owner, options);
}

/** One cold-probe score for an item, the probe side of the comparison. */
export interface ProbeRow {
  chapter: string;
  kind: "what-why" | "invariant";
  item: string;
  score: number;
}

export interface TimedItemAgreement {
  chapter: string;
  item: string;
  probe: number;
  human: number;
  agree: boolean;
}

export interface TimedChapterReading {
  chapter: string;
  agreement: number | null;
  overload: number | null;
  probe_undefined_share: number;
}

export interface TimedComparison {
  items: TimedItemAgreement[];
  agreement: number | null;
  chapters: TimedChapterReading[];
  /** Pearson r between overload and the probe's undefined share across chapters; null under 2 chapters or no spread. */
  overload_correlation: number | null;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = (flags: readonly boolean[]): number | null => (flags.length === 0 ? null : flags.filter(Boolean).length / flags.length);

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const [mx, my] = [mean(xs), mean(ys)];
  const cov = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i]! - my), 0);
  const spread = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return spread === 0 ? null : cov / spread;
}

const timedChapter = (row: Pick<OwnerRow, "scope">): string | null => (row.scope.startsWith(TIMED_SCOPE) ? row.scope.slice(TIMED_SCOPE.length) : null);

function pairedItems(probe: readonly ProbeRow[], human: readonly OwnerRow[]): TimedItemAgreement[] {
  const heard = new Map(human.flatMap((row) => (timedChapter(row) === null || !isScored(row.item) ? [] : [[`${timedChapter(row)}|${row.item}`, Number(row.value)] as const])));
  return probe.flatMap(({ chapter, kind, item, score }) => {
    const given = heard.get(`${chapter}|${kind}:${item}`);
    return given === undefined ? [] : [{ chapter, item: `${kind}:${item}`, probe: score, human: given, agree: score >= 1 === given >= 1 }];
  });
}

/**
 * Compares the cold probe with the human's timed answers. An item agrees when both say it was
 * conveyed (score of 1 or more) or both say it was not; items only one side rated are left out.
 */
export function compareTimed(probe: readonly ProbeRow[], human: readonly OwnerRow[]): TimedComparison {
  const items = pairedItems(probe, human);
  const chapters = [...new Set(items.map((i) => i.chapter))].map((chapter): TimedChapterReading => {
    const own = items.filter((i) => i.chapter === chapter);
    const overload = human.find((row) => timedChapter(row) === chapter && row.item === OVERLOAD_ITEM);
    const undefinedShare = share(own.map((i) => i.probe === 0)) ?? 0;
    return { chapter, agreement: share(own.map((i) => i.agree)), overload: overload ? Number(overload.value) : null, probe_undefined_share: undefinedShare };
  });
  const rated = chapters.filter((c) => c.overload !== null);
  return {
    items,
    agreement: share(items.map((i) => i.agree)),
    chapters,
    overload_correlation: pearson(rated.map((c) => c.overload!), rated.map((c) => c.probe_undefined_share)),
  };
}
