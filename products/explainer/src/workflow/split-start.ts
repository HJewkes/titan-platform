import type { L0Result } from "../eval-l0.js";
import type { Stamped } from "../ledger-stamp.js";
import type { ScriptV1 } from "../script-schema.js";
import { splitKeeps } from "../repair-hints-screen.js";
import { splitPieceClauses } from "../split-piece-rules.js";
import { splitCuelessBeats, splitHint, type Split } from "../script-split.js";
import { seedHint, seedStillCues } from "../still-seed.js";
import { makesProgress, type Candidate, type Repaired } from "./script-draft.js";

/** Where the repair rounds start: the seed, or its $0 split and still seed with the hint naming what is still owed. */
interface Start {
  stamped: Stamped;
  /** The split's line in the repair's failure list; absent when the rounds start from the seed. */
  hint?: string;
  candidates: Candidate[];
}

type Failing = (script: ScriptV1) => L0Result[];
type Settle = (script: ScriptV1) => Stamped;

const CUE_GAP_ID = "Q-D17";

const clearsCueGap = (rows: readonly L0Result[], pieces: readonly string[]): boolean =>
  !rows.some((row) => row.check_id === CUE_GAP_ID && row.detail_beats.some((beat) => pieces.includes(beat)));

// The keep clauses are cuelessMove's own, and the piece rules (split-piece-rules.ts) are the clauses a piece's claim, chip and labels must pass.
function splitLine(split: Split, seed: ScriptV1): string {
  const beat = seed.beats.find((candidate) => candidate.id === split.id);
  const keeps = beat === undefined ? "" : splitKeeps(beat);
  return `${splitHint(split)}; keep each piece's fact_ids${keeps}; ${splitPieceClauses()}`;
}

/**
 * The split starts the rounds when it clears Q-D17 on every piece and fails no more rows than the seed. It swaps that
 * row for the pieces' unlinked boundaries and copied claim, which only the model can write, so it is a start and never
 * an answer: `keptOverSeed` still asks the repaired script to fail fewer rows than the seed, or the seed's own rows on fewer beats.
 */
function claimSplit(seed: Stamped, failing: Failing, settle: Settle): Start {
  const { script, splits } = splitCuelessBeats(seed.script);
  if (splits.length === 0) return { stamped: seed, candidates: [] };
  const stamped = settle(script);
  const rows = failing(stamped.script);
  const pieces = splits.flatMap((split) => split.pieces);
  if (!clearsCueGap(rows, pieces) || rows.length > failing(seed.script).length) return { stamped: seed, candidates: [] };
  return { stamped, hint: splits.map((split) => `- split: ${splitLine(split, seed.script)}`).join("\n"), candidates: [{ kind: "split", text: `${JSON.stringify(stamped.script, null, 2)}\n` }] };
}

const withLine = (hint: string | undefined, line: string): string => (hint === undefined ? line : `${hint}\n${line}`);

/**
 * The still seed (still-seed.ts) runs on the split's start and is kept when it makes progress over it. It is a start
 * under the same rule as the split: the model still owes the stretches no named word reaches, and `keptOverSeed` judges the end.
 */
function stillSeed(start: Start, failing: Failing, settle: Settle): Start {
  const { script, moves } = seedStillCues(start.stamped.script);
  if (moves.length === 0) return start;
  const stamped = settle(script);
  if (!makesProgress(failing(stamped.script), failing(start.stamped.script))) return start;
  const candidates = [...start.candidates, { kind: "still-seed", text: `${JSON.stringify(stamped.script, null, 2)}\n` }];
  return { stamped, hint: withLine(start.hint, `- ${seedHint(moves)}`), candidates };
}

/** Where the repair rounds start: the claim-card split, then the still seed over it, each kept only when it helps. */
export const splitStart = (seed: Stamped, failing: Failing, settle: Settle): Start => stillSeed(claimSplit(seed, failing, settle), failing, settle);

/**
 * The repaired script when it fails fewer rows than the seed, or a reply was kept and it fails the same rows over
 * fewer beats with none the seed did not fail; else the seed, with the spend and what was tried.
 */
export function keptOverSeed(repaired: Repaired, seed: Stamped, seedFailing: readonly L0Result[]): Repaired {
  // A kept reply is what sets `stripped`, so a split start nobody answered never counts as progress over the seed.
  const better = repaired.after < seedFailing.length || (repaired.stripped !== undefined && makesProgress(repaired.rows, seedFailing));
  if (better) return { ...repaired, before: seedFailing.length };
  const { length: rows } = seedFailing;
  return { script: seed.script, stamps: seed.stamps, usage: repaired.usage, before: rows, after: rows, rows: [...seedFailing], candidates: repaired.candidates, spliced: [] };
}

/** The failure list a round sends, with the split's line when the rounds started from one; each is kept for the stage note. */
export function hinted(sent: string[], failures: string, hint: string | undefined): string {
  const text = hint === undefined ? failures : `${failures}\n${hint}`;
  sent.push(text);
  return text;
}
