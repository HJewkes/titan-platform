import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveEvalView, type EvalBeat } from "./eval-view.js";
import { appendTsv, freezeScript, scriptSha, type BenchLayout } from "./eval-store.js";
import type { MapLayout } from "./map-state.js";
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
export type BlindKey = Record<string, { config_id: string; script_sha: string }>;

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
  const key = JSON.parse(Buffer.from(readFileSync(join(dir, SEALED), "utf8"), "base64").toString("utf8")) as BlindKey;
  appendTsv<OwnerRow>(ownerPath(bench), OWNER_COLUMNS, toRows(bench, session, key, answers, options));
  writeFileSync(join(dir, OPENED), `${JSON.stringify(key, null, 2)}\n`);
  return key;
}
