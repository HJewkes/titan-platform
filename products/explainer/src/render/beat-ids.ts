import { z } from "zod";
import { keptBeats } from "../resolve-stage.js";

/** Storyboard ids `beat-01` on, one per script beat id, in the order given. */
export function beatIdMap(scriptIds: readonly string[]): Map<string, string> {
  const width = Math.max(2, String(scriptIds.length).length);
  return new Map(scriptIds.map((id, i) => [id, `beat-${String(i + 1).padStart(width, "0")}`]));
}

/**
 * The storyboard id of each beat resolve kept, in script order. This is the one place script ids become beat-NN
 * ids (TP-2990 Q4): render's board, words.json and wavs, and QA's beat sets all go through it.
 */
export function storyboardIds(script: { beats: readonly { id: string }[] }, resolved: Parameters<typeof keptBeats>[1]): Map<string, string> {
  return beatIdMap(keptBeats(script.beats, resolved).map((beat) => beat.id));
}

const WordsBeatsSchema = z.looseObject({ beats: z.array(z.looseObject({ id: z.string() })) });

/** A words.json with each beat under its storyboard id; a beat the map lacks keeps its id, so compile names it. */
export function renameWordsBeats(words: unknown, ids: ReadonlyMap<string, string>): unknown {
  const parsed = WordsBeatsSchema.parse(words);
  return { ...parsed, beats: parsed.beats.map((beat) => ({ ...beat, id: ids.get(beat.id) ?? beat.id })) };
}
