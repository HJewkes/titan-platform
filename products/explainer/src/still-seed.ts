import { emphasisTargets } from "./beat-load.js";
import { SMALL_MOVE_S } from "./composition/beats/stage/video.js";
import { cueWord } from "./cues.js";
import { drawnBeats, screenTokens, type DrawnBeat } from "./drawn-beats.js";
import { doctrine, heldBeats, plannedCues, scriptPacing } from "./lint-cadence.js";
import { stillBeats, targetWords, type StillStretch } from "./lint-still.js";
import { plainWords, type ScriptBeat, type ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { marked } from "./template-fill/label-parse.js";
import { DEFAULT_PADDING } from "./workflow/tts-truing.js";

/**
 * A $0 pass over Q-D22's still stretches before the repair (TP-4548). Every move is naming-only: a cue lands only on a
 * spoken word that names its element's own on-screen text or spoken value, which is pointing, never a pulse on a word
 * that names nothing. A cue-less claim-card with nothing to name is held while the profile's held band has room.
 * Like the claim-card split, the result is the repair's start, never its answer.
 */

type Pacing = NonNullable<ReturnType<typeof scriptPacing>>;
type Cue = ScriptBeat["visual"]["cues"][number];

/** One move the seed made, for the repair's hint. */
interface SeedMove {
  beat: string;
  rule: "retime" | "uncued" | "point" | "hold";
  target?: string;
  atCue?: string;
}

interface Seeded {
  script: ScriptV1;
  moves: SeedMove[];
}

/** One spoken word as a cue names it, with its sentence and its time on the voiced clock from the cut. */
export interface SpokenWord {
  raw: string;
  cue: string;
  tokens: string[];
  sentence: number;
  s: number;
}

/** An element a cue may point at, with the words that name it and nothing beside it. */
interface Element {
  target: string;
  names: Set<string>;
  /** When the element lands, on the voiced clock; undefined for one not drawn yet. */
  shownS?: number;
}

// Words that name no element on their own, however often a label repeats them.
const FUNCTION_WORDS = new Set(
  [
    "a about after all also an and are as at be before but by can could did do does each every for from had has have he her his",
    "how i in into is it its just me more most my no not now of off on only or our out over she since so still than that the",
    "their them then they this those to too under until up us very was we were what when where which who will with would you your",
  ].join(" ").split(" "),
);
const SENTENCE_END = /[.!?]["')\]]*$/;

/** The beat's spoken words in order, each with its cue form (`word#n` past the first) and its planned time. */
export function spokenWords(beat: ScriptBeat): SpokenWord[] {
  const clock = plannedCues(beat);
  const seen = new Map<string, number>();
  let sentence = 0;
  return plainWords(beat.spoken).flatMap((raw) => {
    const form = cueWord(raw);
    const rank = (seen.get(form) ?? 0) + 1;
    seen.set(form, rank);
    const cue = rank === 1 ? form : `${form}#${rank}`;
    const s = DEFAULT_PADDING.leadS + Math.min(clock?.endS ?? 0, clock?.wordS(cue) ?? 0);
    const word = { raw, cue, tokens: screenTokens(raw), sentence, s };
    if (SENTENCE_END.test(raw)) sentence += 1;
    return form === "" ? [] : [word];
  });
}

const spelled = (beat: ScriptBeat, words: Set<string>): string[] => screenTokens(spellSpokenNumbers({ spoken: [...words].join(" "), visual: beat.visual }).spoken);

/** Each element's words less any a sibling shares or that names nothing, so a word points at one element only. */
function distinct(raw: readonly { target: string; words: Set<string>; shownS?: number }[]): Element[] {
  const count = new Map<string, number>();
  for (const { words } of raw) for (const word of words) count.set(word, (count.get(word) ?? 0) + 1);
  const named = (word: string) => count.get(word) === 1 && word.length > 1 && !FUNCTION_WORDS.has(word);
  return raw.map(({ target, words, shownS }) => ({ target, names: new Set([...words].filter(named)), ...(shownS === undefined ? {} : { shownS }) }));
}

const timeOf = (words: readonly SpokenWord[], cue: string): number | undefined => words.find((word) => word.cue === cue)?.s;

// A template element is one the emphasis gate resolves and the fill reveals: its slot text and its value as voiced.
function drawnElements(beat: ScriptBeat, drawn: DrawnBeat, words: readonly SpokenWord[]): Element[] {
  const spec = doctrine().specs.get(drawn.filled.spec);
  const targets = new Set(spec ? emphasisTargets(spec, drawn.filled.slots) : []);
  const shown = drawn.filled.reveals.filter((reveal) => targets.has(reveal.target));
  return distinct(
    shown.map(({ target, atCue }) => {
      const own = targetWords(drawn.filled.slots, target);
      return { target, words: new Set([...own, ...spelled(beat, own)]), shownS: timeOf(words, atCue) ?? DEFAULT_PADDING.leadS };
    }),
  );
}

// A custom layer's elements are its cue targets: the words they land on, and the one label whose text holds such a word.
function customElements(beat: ScriptBeat, words: readonly SpokenWord[]): Element[] {
  const labels = beat.visual.labels.map((label) => new Set(screenTokens(marked(label).text)));
  const targets = [...new Set(beat.visual.cues.map((cue) => cue.target))];
  return distinct(
    targets.map((target) => {
      const cued = beat.visual.cues.filter((cue) => cue.target === target).map((cue) => cue.atCue);
      const own = new Set(cued.flatMap((cue) => screenTokens(cue.split("#")[0]!)));
      const held = labels.filter((label) => [...own].some((word) => label.has(word)));
      const label = held.length === 1 ? [...held[0]!] : [];
      const shownS = Math.min(...cued.map((cue) => timeOf(words, cue) ?? Infinity));
      return { target, words: new Set([...own, ...label]), ...(Number.isFinite(shownS) ? { shownS } : {}) };
    }),
  );
}

// A word written in digits is voiced as other words, so its cue would not land where the clock puts it.
const names = (element: Element, word: SpokenWord): boolean => !/\d/.test(word.raw) && word.tokens.some((token) => element.names.has(token));

interface BeatView {
  beat: ScriptBeat;
  words: SpokenWord[];
  elements: Element[];
  drawn: boolean;
}

function viewsOf(script: ScriptV1): Map<string, BeatView> {
  const drawn = new Map(drawnBeats(script).map((beat) => [beat.filled.id, beat]));
  return new Map(
    script.beats.map((beat) => {
      const words = spokenWords(beat);
      const filled = drawn.get(beat.id);
      return [beat.id, { beat, words, elements: filled ? drawnElements(beat, filled, words) : customElements(beat, words), drawn: filled !== undefined }];
    }),
  );
}

const cueOn = (target: string, atCue: string): Cue => ({ action: "V6", target, atCue });

/** Rule 1: each element's first cue moves to the earliest word of its sentence that names the element. */
function retimed(view: BeatView, moves: SeedMove[]): Cue[] {
  const first = new Set<string>();
  return view.beat.visual.cues.map((cue) => {
    const element = view.elements.find((found) => found.target === cue.target);
    const at = view.words.find((word) => word.cue === cue.atCue);
    if (first.has(cue.target) || !element || !at) return cue;
    first.add(cue.target);
    const named = view.words.find((word) => word.sentence === at.sentence && names(element, word));
    if (!named || named.cue === cue.atCue) return cue;
    moves.push({ beat: view.beat.id, rule: "retime", target: cue.target, atCue: named.cue });
    return { ...cue, atCue: named.cue };
  });
}

/** Rule 2: a drawn element no script cue reveals gets a cue on the first word that names it. */
function uncued(view: BeatView, cues: readonly Cue[], moves: SeedMove[]): Cue[] {
  if (!view.drawn) return [];
  const cued = new Set(cues.map((cue) => cue.target));
  return view.elements.flatMap((element) => {
    const named = cued.has(element.target) ? undefined : view.words.find((word) => names(element, word));
    if (!named) return [];
    moves.push({ beat: view.beat.id, rule: "uncued", target: element.target, atCue: named.cue });
    return [cueOn(element.target, named.cue)];
  });
}

const withCues = (script: ScriptV1, cues: ReadonlyMap<string, Cue[]>): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (cues.has(beat.id) ? { ...beat, visual: { ...beat.visual, cues: cues.get(beat.id)! } } : beat)),
});

function namedCues(script: ScriptV1, moves: SeedMove[]): ScriptV1 {
  const cues = new Map<string, Cue[]>();
  for (const view of viewsOf(script).values()) {
    const before = moves.length;
    const kept = retimed(view, moves);
    const added = uncued(view, kept, moves);
    if (moves.length > before) cues.set(view.beat.id, [...kept, ...added]);
  }
  return cues.size > 0 ? withCues(script, cues) : script;
}

/** Rule 3: the word nearest the stretch's middle that names an element already shown, clear of both ends. */
function pointer(view: BeatView, { fromS, toS }: StillStretch): Cue | undefined {
  const taken = new Set(view.beat.visual.cues.map((cue) => cue.atCue));
  const middle = (fromS + toS) / 2;
  const inside = view.words.filter((word) => word.s - fromS >= SMALL_MOVE_S && toS - word.s >= SMALL_MOVE_S && !taken.has(word.cue));
  const pointed = inside.flatMap((word) => {
    const element = view.elements.find((found) => found.shownS !== undefined && found.shownS <= word.s && names(found, word));
    return element ? [{ word, element }] : [];
  });
  const nearest = pointed.sort((a, b) => Math.abs(a.word.s - middle) - Math.abs(b.word.s - middle))[0];
  return nearest && cueOn(nearest.element.target, nearest.word.cue);
}

function pointedCues(script: ScriptV1, pacing: Pacing, moves: SeedMove[]): ScriptV1 {
  const views = viewsOf(script);
  const cues = new Map<string, Cue[]>();
  for (const { beat, stretches } of stillBeats(script, pacing)) {
    const view = views.get(beat.id)!;
    const added = stretches.flatMap((stretch) => pointer(view, stretch) ?? []);
    for (const cue of added) moves.push({ beat: beat.id, rule: "point", target: cue.target, atCue: cue.atCue });
    if (added.length > 0) cues.set(beat.id, [...beat.visual.cues, ...added]);
  }
  return cues.size > 0 ? withCues(script, cues) : script;
}

const longest = (stretches: readonly StillStretch[]): number => Math.max(...stretches.map(({ fromS, toS }) => toS - fromS));

/** Rule 4: still cue-less claim-cards are held, the longest still first, while the held band has room (G12). */
function heldCards(script: ScriptV1, pacing: Pacing, moves: SeedMove[]): ScriptV1 {
  const cards = new Set(drawnBeats(script).filter(({ filled }) => filled.spec === "claim-card").map(({ filled }) => filled.id));
  const room = pacing.held[1] - heldBeats(script.beats).length;
  const still = stillBeats(script, pacing).filter(({ beat }) => cards.has(beat.id) && beat.visual.cues.length === 0);
  const held = new Set(still.sort((a, b) => longest(b.stretches) - longest(a.stretches)).slice(0, Math.max(0, room)).map(({ beat }) => beat.id));
  if (held.size === 0) return script;
  for (const beat of held) moves.push({ beat, rule: "hold" });
  return { ...script, beats: script.beats.map((beat) => (held.has(beat.id) ? { ...beat, heldS: pacing.staticMaxS } : beat)) };
}

/** The script with Q-D22's stretches seeded by the four naming-only rules, and each move made; as it came when none applies. */
export function seedStillCues(script: ScriptV1): Seeded {
  const pacing = scriptPacing(script);
  if (!pacing || stillBeats(script, pacing).length === 0) return { script, moves: [] };
  const moves: SeedMove[] = [];
  const named = namedCues(script, moves);
  const pointed = pointedCues(named, pacing, moves);
  return { script: heldCards(pointed, pacing, moves), moves };
}

const moveText = ({ beat, rule, target, atCue }: SeedMove): string =>
  rule === "hold" ? `${beat} held` : `${beat} ${target} on "${atCue}"${rule === "retime" ? " (moved)" : ""}`;

/** The repair's line on the seed: what code did, so a reply keeps those cues. */
export const seedHint = (moves: readonly SeedMove[]): string =>
  `still seed: code cued each element on a word that names it (${moves.map(moveText).join(", ")}); keep these cues and holds, and fix the stretches still listed`;
