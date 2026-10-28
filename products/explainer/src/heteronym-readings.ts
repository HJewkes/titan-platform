import { englishHeteronyms, type HeteronymTable } from "@titan-design/speech-vet";
import type { ScriptV1 } from "./script-schema.js";

// A link is one token, so a word already declared or overridden is context and never declared again.
const TOKEN = /\[([^\]]+)\]\([^)]*\)|[A-Za-z0-9]+(?:'[A-Za-z]+)*/g;
const PAUSE = /[.,;:!?()—–-]/;

interface Token {
  text: string;
  start: number;
  end: number;
  bare: boolean;
}

/** What a rule reads around one bare occurrence: its spelling, its neighbours, and whether a pause follows it. */
interface Context {
  form: string;
  prev?: string;
  next?: string;
  pause: boolean;
}

type Rule = (context: Context) => string | undefined;

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

// The time unit heads its phrase, so a pause or a function word follows it; the adjective modifies the noun after it.
const AFTER_TIME = words("later ago earlier or and of to in for before after from on at by with per then when while is was has had left");
// "more", "less" and "so" also count time ("one more minute"), so they decide nothing.
const INTENSIFIERS = words("very too most quite rather extremely");

/** "minutes" is always the time unit: the adjective does not inflect. */
const minute: Rule = ({ form, prev = "", next = "", pause }) => {
  if (form === "minutes") return "time";
  if (INTENSIFIERS.has(prev)) return "tiny";
  if (pause || AFTER_TIME.has(next)) return "time";
  return prev === "a" || prev === "an" ? "tiny" : undefined;
};

// Closed-class words only: the g2p tagger was measured reading "daily use" and "live" as verbs. Determiners that can
// stand alone as a subject ("this", "each", "some") are left out: "This records the scan" is a verb.
const NOUN_BEFORE = words("a an the its their our your my every no of in for");
const VERB_BEFORE = words("can cannot could will would shall should may might must do does did don't doesn't didn't won't can't");
const SUBJECTS = words("i we you they");
const S_SUBJECTS = words("he she it");

// "to" before a pause is a preposition ("put to use."), so only "to" with words after it marks an infinitive, and
// never before an -s form ("writes to records of"), which an infinitive cannot take.
const infinitive = ({ form, prev, pause }: Context): boolean => prev === "to" && !pause && !form.endsWith("s");

const nounOrVerb: Rule = (context) => {
  const prev = context.prev ?? "";
  if (NOUN_BEFORE.has(prev)) return "noun";
  const subjects = context.form.endsWith("s") ? S_SUBJECTS : SUBJECTS;
  return VERB_BEFORE.has(prev) || subjects.has(prev) || infinitive(context) ? "verb" : undefined;
};

const PERFECT_OR_PASSIVE = words("has have had having is are was were be been being");

const read: Rule = (context) => {
  const prev = context.prev ?? "";
  if (PERFECT_OR_PASSIVE.has(prev)) return "past";
  return VERB_BEFORE.has(prev) || infinitive(context) ? "present" : undefined;
};

const OWN_RULES: Readonly<Record<string, Rule>> = { minute, read };

/** The rule for a table word: its own, or the noun/verb rule for any word whose readings are just those two. */
function ruleFor(word: string, table: HeteronymTable): Rule | undefined {
  const names = Object.keys(table.words[word]?.readings ?? {}).sort().join(" ");
  return OWN_RULES[word] ?? (names === "noun verb" ? nounOrVerb : undefined);
}

function tokensOf(spoken: string): Token[] {
  return [...spoken.matchAll(TOKEN)].map((match) => ({
    text: match[1] ?? match[0],
    start: match.index,
    end: match.index + match[0].length,
    bare: match[1] === undefined,
  }));
}

function contextAt(spoken: string, tokens: readonly Token[], i: number): Context {
  const [before, token, after] = [tokens[i - 1], tokens[i]!, tokens[i + 1]];
  const pause = after === undefined || PAUSE.test(spoken.slice(token.end, after.start));
  return { form: token.text.toLowerCase(), prev: before?.text.toLowerCase(), next: after?.text.toLowerCase(), pause };
}

function tableWordOf(form: string, table: HeteronymTable): string | undefined {
  return Object.entries(table.words).find(([, { forms }]) => forms.includes(form))?.[0];
}

/** The reading context decides for one bare heteronym token, or undefined when it is not one or context cannot tell. */
function decidedReading(spoken: string, tokens: readonly Token[], i: number, table: HeteronymTable): string | undefined {
  const context = contextAt(spoken, tokens, i);
  const word = tableWordOf(context.form, table);
  if (!tokens[i]!.bare || word === undefined) return undefined;
  const reading = ruleFor(word, table)?.(context);
  return reading !== undefined && reading in table.words[word]!.readings ? reading : undefined;
}

/**
 * The line with a `[w](=reading)` declaration on each bare heteronym whose reading its neighbours decide. One they
 * leave open stays bare, so Q-V10 still names it rather than a guess passing unheard.
 */
export function declareReadings(spoken: string, table: HeteronymTable = englishHeteronyms): string {
  const tokens = tokensOf(spoken);
  let out = "";
  let last = 0;
  tokens.forEach((token, i) => {
    const reading = decidedReading(spoken, tokens, i, table);
    if (reading === undefined) return;
    out += `${spoken.slice(last, token.start)}[${token.text}](=${reading})`;
    last = token.end;
  });
  return out + spoken.slice(last);
}

/** Every beat's spoken line with the readings its context decides declared. */
export const declareScriptReadings = (script: ScriptV1): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => ({ ...beat, spoken: declareReadings(beat.spoken) })),
});
