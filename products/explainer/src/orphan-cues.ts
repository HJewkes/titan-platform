import type { L0Result } from "./eval-l0.js";
import { planFaults, strictSubset } from "./script-budget.js";
import { orphanCues } from "./script-fill.js";
import type { ScriptV1 } from "./script-schema.js";

type Failing = (script: ScriptV1) => L0Result[];

const failedPairs = (rows: readonly L0Result[]): string[] =>
  rows.flatMap((row) => (row.detail_beats.length > 0 ? row.detail_beats : [""]).map((beat) => `${row.check_id} ${beat}`));

/** Whether every check and beat `after` fails, `before` already failed. */
const noNewFailure = (after: readonly L0Result[], before: readonly L0Result[]): boolean => {
  const was = new Set(failedPairs(before));
  return failedPairs(after).every((pair) => was.has(pair));
};

function withoutCues(script: ScriptV1, id: string, drop: readonly number[]): ScriptV1 {
  const beats = script.beats.map((beat) => (beat.id === id ? { ...beat, visual: { ...beat.visual, cues: beat.visual.cues.filter((_, i) => !drop.includes(i)) } } : beat));
  return { ...script, beats };
}

const moveText = (script: ScriptV1, id: string, drop: readonly number[]): string => {
  const cues = script.beats.find((beat) => beat.id === id)!.visual.cues;
  return `orphan cue dropped: ${id} ${drop.map((i) => cues[i]!.target).join(", ")} (names no element the fill draws)`;
};

/**
 * The $0 fix for a template-fill row on cue targets alone: a cue whose target names no element the fill draws can
 * never animate, so dropping it changes no frame. One beat at a time, a drop is kept only when the plan check fails a
 * strict subset of what it failed and `failing` names no check on a beat it did not already, so a drop that opens a
 * Q-D17 gap stays for the repair. A beat whose every cue is an orphan keeps them, since the repair must re-aim them.
 */
export function dropOrphanCues(script: ScriptV1, failing: Failing): { script: ScriptV1; moves: string[] } {
  let kept = script;
  const moves: string[] = [];
  for (const [id, drop] of orphanCues(script)) {
    if (drop.length === script.beats.find((beat) => beat.id === id)!.visual.cues.length) continue;
    const next = withoutCues(kept, id, drop);
    if (!strictSubset(planFaults(next), planFaults(kept)) || !noNewFailure(failing(next), failing(kept))) continue;
    moves.push(moveText(kept, id, drop));
    kept = next;
  }
  return { script: kept, moves };
}
