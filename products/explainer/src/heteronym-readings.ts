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

/**
 * What a rule reads around one bare occurrence: its spelling and its neighbours within the clause. A pause before the
 * token clears `prev`, so an earlier sentence's last word never reads as this one's determiner.
 */
interface Context {
  form: string;
  prev?: string;
  /** Whether `prev` opens its clause, as a modal does in a question ("Can projects ship?"). */
  prevLeads: boolean;
  next?: string;
  pause: boolean;
}

type Rule = (context: Context) => string | undefined;

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

// Each rule names a reading only for a (prev, form, next) pattern the grammar allows one reading in, and falls through
// to undefined otherwise: a wrong declaration passes Q-V10 unheard, a bare word fails it.

// A counted "minute" is the time unit once a pause or a function word ends its phrase; "a minute longer", "a minute
// each" and "a minute detail" are all open, so a determiner alone decides nothing.
const COUNTS_TIME = words("a an one the this that each every per last next first final same another more");
const AFTER_TIME = words("later ago earlier or and of to in for before after from on at by with per then when while is was has had left");
// Only before the adjective: "very" also precedes the noun ("the very minute"), so it is left out.
const INTENSIFIERS = words("too quite rather extremely most");

/** "minutes" is always the time unit: the adjective does not inflect. */
const minute: Rule = ({ form, prev = "", next = "", pause }) => {
  if (form === "minutes") return "time";
  if (INTENSIFIERS.has(prev)) return "tiny";
  return COUNTS_TIME.has(prev) && (pause || AFTER_TIME.has(next)) ? "time" : undefined;
};

// Closed-class words only: the g2p tagger was measured reading "daily use" and "live" as verbs. Determiners that can
// stand alone as a subject ("this", "each", "some") and "in" ("sign in records") are left out.
const NOUN_BEFORE = words("a an the its their our your my every no of for");
// Plain "do" inverts in questions ("why do records matter?"), so only its negations, which precede the verb, count.
const MODALS = words("can cannot could will would shall should may might must don't doesn't didn't won't can't");
const SUBJECTS = words("i we they");
const S_SUBJECTS = words("he she it");
// An infinitive's object opens with one of these ("to use the scanner"); "to use across" and "to present levels" may be
// the preposition, so they stay open.
const OBJECT_START = words("a an the this that these those its their our your my his her them it us me each every some all any");

const baseForm = (form: string): boolean => !form.endsWith("s");

/** A modal mid-clause before a base form: "couriers can use". A leading modal asks a question whose subject follows. */
const afterModal = ({ form, prev = "", prevLeads }: Context): boolean => MODALS.has(prev) && !prevLeads && baseForm(form);

const infinitive = ({ form, prev, next = "", pause }: Context): boolean =>
  prev === "to" && !pause && baseForm(form) && OBJECT_START.has(next);

const afterSubject = ({ form, prev = "" }: Context): boolean => (baseForm(form) ? SUBJECTS : S_SUBJECTS).has(prev);

const nounOrVerb: Rule = (context) => {
  if (NOUN_BEFORE.has(context.prev ?? "")) return "noun";
  return afterModal(context) || afterSubject(context) || infinitive(context) ? "verb" : undefined;
};

const PERFECT_OR_PASSIVE = words("has have had having is are was were be been being");

const read: Rule = (context) => {
  if (PERFECT_OR_PASSIVE.has(context.prev ?? "")) return "past";
  return afterModal(context) || infinitive(context) ? "present" : undefined;
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

/** Whether a pause, or the line's edge, separates tokens i and i + 1. */
function breakAfter(spoken: string, tokens: readonly Token[], i: number): boolean {
  const [token, after] = [tokens[i], tokens[i + 1]];
  return token === undefined || after === undefined || PAUSE.test(spoken.slice(token.end, after.start));
}

function contextAt(spoken: string, tokens: readonly Token[], i: number): Context {
  const [token, after] = [tokens[i]!, tokens[i + 1]];
  const prev = breakAfter(spoken, tokens, i - 1) ? undefined : tokens[i - 1]!.text.toLowerCase();
  const prevLeads = prev === undefined || breakAfter(spoken, tokens, i - 2);
  const form = token.text.toLowerCase();
  return { form, prev, prevLeads, next: after?.text.toLowerCase(), pause: breakAfter(spoken, tokens, i) };
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
