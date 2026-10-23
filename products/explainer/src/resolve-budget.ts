import type { BeatSpec, SpeechBand } from "./beat-schema.js";
import { wordsOf } from "./lint-text.js";
import type { TypeProfile } from "./profile-schema.js";
import type { ScriptBeat } from "./script-schema.js";
import type { SpeechBands } from "./speech-bands.js";

export interface BudgetRow {
  scope: "beat" | "block";
  id: string;
  words: number;
  seconds: number;
  wordsPerS: number;
  /** The most words the slot holds: seconds times the rate, rounded down. */
  cap: number;
}

interface BlockBudgets {
  rows: BudgetRow[];
  /** Chapters whose id names no block of the profile, so no block cap applies to their beats. */
  unplaced: string[];
}

const row = (scope: BudgetRow["scope"], id: string, words: number, seconds: number, wordsPerS: number): BudgetRow => ({
  scope, id, words, seconds, wordsPerS, cap: Math.floor(seconds * wordsPerS + 1e-9),
});

/** One beat's spoken words against its planned slot at its beat type's band cap (doctrine `speech-bands.yaml`). */
export function beatBudget(beat: Pick<ScriptBeat, "id" | "spoken" | "plannedS">, band: SpeechBand, bands: SpeechBands): BudgetRow {
  return row("beat", beat.id, wordsOf(beat.spoken).length, beat.plannedS, bands[band].wordsPerS);
}

/** The fastest rate any beat type the block allows may speak at; undefined when the registry knows none of them. */
function blockRate(block: TypeProfile["structure"]["blocks"][number], specs: ReadonlyMap<string, BeatSpec>, bands: SpeechBands): number | undefined {
  const rates = [...block.beats, ...(block.require ?? [])].flatMap((type) => {
    const spec = specs.get(type);
    return spec ? [bands[spec.speech.band].wordsPerS] : [];
  });
  return rates.length > 0 ? Math.max(...rates) : undefined;
}

/**
 * Each profile block's words against its longest airtime, at the fastest rate its beat types allow. A script chapter
 * is a block when its id names one; the beats of any other chapter are listed as unplaced, not capped.
 */
export function blockBudgets(
  beats: readonly Pick<ScriptBeat, "chapter" | "spoken">[],
  profile: TypeProfile,
  specs: ReadonlyMap<string, BeatSpec>,
  bands: SpeechBands,
): BlockBudgets {
  const blocks = new Map(profile.structure.blocks.map((block) => [block.id, block]));
  const unplaced = [...new Set(beats.map((beat) => beat.chapter).filter((chapter) => !blocks.has(chapter)))];
  const rows = [...blocks.values()].flatMap((block) => {
    const rate = blockRate(block, specs, bands);
    const inBlock = beats.filter((beat) => beat.chapter === block.id);
    if (rate === undefined || inBlock.length === 0) return [];
    return [row("block", block.id, inBlock.reduce((sum, beat) => sum + wordsOf(beat.spoken).length, 0), block.seconds[1], rate)];
  });
  return { rows, unplaced };
}

const overBudget = (rows: readonly BudgetRow[]): BudgetRow[] => rows.filter((budget) => budget.words > budget.cap);

/** The word-budget gate's verdict: pass when no beat or block runs over its cap. */
export function budgetVerdict(rows: readonly BudgetRow[]): { pass: boolean; detail: string } {
  const over = overBudget(rows);
  const shown = over.slice(0, 5).map((r) => `${r.scope} ${r.id} ${r.words} words > ${r.cap} (${r.seconds} s at ${r.wordsPerS} w/s)`);
  const more = over.length > 5 ? ` and ${over.length - 5} more` : "";
  return { pass: over.length === 0, detail: `${over.length} of ${rows.length} word budgets over${over.length ? `: ${shown.join(", ")}${more}` : ""}` };
}
