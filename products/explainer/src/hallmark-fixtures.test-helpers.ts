import { textHallmarkRows, type HallmarkBeat } from "./lint-hallmarks.js";
import { tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// Synthetic garden lines: 16 words each, every one opening on its own three words, so no hallmark fires on them.
const OPENERS = ["Rain", "Soil", "Seeds", "Roots", "Weeds", "Mulch", "Compost", "Sunlight", "Frost", "Worms"];
export const FILLER = OPENERS.map((opener) => `${opener} in the garden change slowly over a season, and a patient grower learns to read them well.`);

export const NAMING = ["That little whistle is called the vent note.", "That metal plate is called the base.", "That narrow gap is called the spout."];

export const beatsOf = (lines: readonly string[], chapter = "ch1"): HallmarkBeat[] => lines.map((spoken, i) => ({ id: `b${i + 1}`, spoken, chapter }));
export const rowOf = (beats: readonly HallmarkBeat[], id: string) => textHallmarkRows(beats).find((row) => row.id === id)!;
/** The filler's 160 words, then these lines as beats b11 onward. */
export const withFiller = (...lines: string[]): HallmarkBeat[] => beatsOf([...FILLER, ...lines]);
/** A script/v1 tour of these beats, its thesis refs pointed at the first three. */
export const tourOf = (specs: BeatSpec[]) => tour(specs, { thesis_refs: specs.slice(0, 3).map(([id]) => id) });
