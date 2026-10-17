import type { WordToken } from "./lexer.js";
import { mayGenerate } from "./word-generation.js";
import { afterSkippedDashes, WRITER_SPECS } from "./writer-specs.js";
import type { WriterSpec } from "./writer-specs.js";

/** How a builtin whose options name, or decide, the parameter it stores into reads its option words. */
interface StoreOptionBuiltin {
  /** The option letters that store into a parameter, or make an operand one; empty when only an operand names it. */
  stores: string;
  /**
   * Letters that take the next word as their value, when nothing is attached, in every shell that knows them; a shell
   * that rejects the letter stores nothing.
   */
  values: string;
  /** Letters that take the next word as their value in one shell and are a flag in the other: bash `read -p`, zsh `read -p`. */
  either?: string;
}

/** `getopts` names its store by position, so it is not in WRITER_SPECS, but a run-time first word may still be an option. */
const GETOPTS: StoreOptionBuiltin = { stores: "", values: "" };

/**
 * The store-option zone: every WRITER_SPECS builtin with a name-valued option or a store flag, with no exemptions, so
 * the zone cannot drift from the table. zsh `stat` is in it although bash runs the external tool: one `zmodload
 * zsh/stat` makes `stat $o commands s` with `o=-LH` store into commands. It also skips one leading `--`, so a run-time
 * file is written `stat ./"$f"`.
 */
export const STORE_OPTION_BUILTINS: ReadonlyMap<string, StoreOptionBuiltin> = new Map([
  ...Object.entries(WRITER_SPECS).flatMap(([name, spec]) => {
    const zone = zoneOf(spec);
    return zone ? [[name, zone] as const] : [];
  }),
  ["getopts", GETOPTS],
]);

function zoneOf(spec: WriterSpec): StoreOptionBuiltin | undefined {
  if (spec.names === undefined && spec.stores === undefined) return undefined;
  const names = spec.names ?? "";
  return {
    stores: names + (spec.stores ?? ""),
    values: names + (spec.values ?? ""),
    ...(spec.either === undefined ? {} : { either: spec.either }),
  };
}

/** A first character no expansion produced, so every word the word yields starts with it and none is an option. */
const LITERAL_LEAD_RE = /^[A-Za-z0-9_./]/;
/** A special parameter that is always a number or empty: `wait $!`. */
const NUMERIC_SPECIAL_RE = /^\$[!$#?]$/;

/**
 * Whether a store builtin may read a run-time word as an option: one where options are still read, before a literal
 * `--` or the first word that cannot be an option, that expands, globs or brace-expands to text that may start with
 * `-` or `+`. Quotes do not help: `set "$x"` with `x=-Acommands` stores in zsh. An unquoted option value counts too,
 * since it may split into options (`print -u $fd`). Writing `--` first (`print -- $x`) is how a line passes.
 */
export function expandsInStoreOptions(name: string, args: WordToken[]): boolean {
  const spec = STORE_OPTION_BUILTINS.get(name);
  if (!spec) return false;
  const words = afterSkippedDashes(name, args);
  let at: Position = { option: true, value: false };
  for (const word of words) {
    if (expands(word) && ((at.value && splits(word)) || (at.option && mayStartOption(word)))) return true;
    at = nextPosition(word, at, spec);
    if (!at.option && !at.value) return false;
  }
  return false;
}

/** Where a word sits in some shell's reading: where options are still read, or as the value of the option before it. */
interface Position {
  option: boolean;
  value: boolean;
}

/**
 * Where the next word sits. A value is followed by options; a word that cannot be an option ends that reading. A
 * run-time word in an option slot that passed `mayStartOption` is not an option, so it ends that reading too.
 */
function nextPosition(word: WordToken, at: Position, spec: StoreOptionBuiltin): Position {
  const option = at.option && !expands(word) && word.value !== "--" && /^[-+]./s.test(word.value);
  const after = option ? clusterEnd(word.value, spec) : { option: false, value: false };
  return { option: at.value || after.option, value: after.value };
}

/**
 * Where a cluster leaves the next word. A value letter takes the rest of the cluster, or the next word when it is
 * last: `-ru` then `3`. An either letter does that in one shell and is a flag in the other, so both readings go on.
 */
function clusterEnd(cluster: string, spec: StoreOptionBuiltin): Position {
  const letters = [...cluster.slice(1)];
  const end: Position = { option: false, value: false };
  for (const [i, letter] of letters.entries()) {
    const last = i === letters.length - 1;
    if (spec.values.includes(letter)) return last ? { ...end, value: true } : { ...end, option: true };
    if (spec.either?.includes(letter)) {
      if (last) return { option: true, value: true };
      end.option = true;
    }
  }
  return { ...end, option: true };
}

function expands(word: WordToken): boolean {
  return word.dynamic || word.unquotedExpansion === true || mayGenerate(word);
}

/** An unquoted expansion or a generated word, either of which may become several words. */
function splits(word: WordToken): boolean {
  return word.unquotedExpansion === true || mayGenerate(word);
}

function mayStartOption(word: WordToken): boolean {
  if (NUMERIC_SPECIAL_RE.test(word.value)) return false;
  const expandedLead = word.refs.some((r) => r.start === 0) || (word.cuts ?? []).some((c) => c.at === 0);
  return expandedLead || !LITERAL_LEAD_RE.test(word.value);
}
