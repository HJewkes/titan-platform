import { ParseError, tokenize } from "./lexer.js";
import type { Token, WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

/** Alias name to the shell texts it may expand to; a name can carry more than one (a built-in floor and the shell's own). */
export type AliasTable = ReadonlyMap<string, readonly string[]>;

/**
 * What an aliased command word runs. Plain-word values splice into the command's words; a value with operators,
 * redirects, expansions or substitutions makes the line's tokens, which run as eval text does.
 */
export type AliasReading = { words: WordToken[] } | { tokens: Token[]; aliases: AliasTable };

/** Bounds a table of aliases that each expand to several values, whose readings would otherwise multiply. */
const MAX_EXPANSIONS = 64;
const MAX_ROUNDS = 16;

/**
 * The readings an alias table gives the command word, each expanded again so a wrapper or another alias in a value
 * reaches its command. A name never expands inside its own expansion, as in zsh and bash. Empty when no alias applies.
 * Throws `ParseError` for a value the lexer rejects or a table past the bounds, so the line goes unchecked.
 */
export function aliasReadings(words: WordToken[], table: AliasTable | null): AliasReading[] {
  if (table === null || table.size === 0) return [];
  const out: AliasReading[] = [];
  expand(words, { table, done: new Set(), budget: { left: MAX_EXPANSIONS }, round: 0 }, out);
  return out;
}

interface Expansion {
  table: AliasTable;
  /** Alias names already expanded on the way to these words. */
  done: ReadonlySet<string>;
  budget: { left: number };
  round: number;
}

function expand(words: WordToken[], x: Expansion, out: AliasReading[]): void {
  const at = commandWordAt(words);
  const name = words[at]?.value ?? null;
  const values = name === null || x.done.has(name) ? undefined : x.table.get(name);
  if (name === null || values === undefined) {
    if (x.round > 0) out.push({ words });
    return;
  }
  if (x.round >= MAX_ROUNDS) throw new ParseError("alias expansion too deep");
  const next = { ...x, done: new Set([...x.done, name]), round: x.round + 1 };
  for (const value of values) {
    if (--x.budget.left < 0) throw new ParseError("too many alias expansions");
    const tokens = tokenize(value);
    if (tokens.every(isPlainWord)) expand(spliced(words, at, tokens), next, out);
    else out.push({ tokens: spliced(words, at, tokens), aliases: without(x.table, next.done) });
  }
}

/** The table eval text walks with: the names expanded on the way there never expand again inside it. */
function without(table: AliasTable, done: ReadonlySet<string>): AliasTable {
  return new Map([...table].filter(([name]) => !done.has(name)));
}

/** The index of the word that names the command, past assignments, keywords and wrappers; -1 when none is static. */
function commandWordAt(words: WordToken[]): number {
  const cmd = unwrap(words);
  // xargs execs its command from PATH, where no alias applies.
  if (!cmd || cmd.xargs !== undefined) return -1;
  return words.findIndex((w) => !w.dynamic && w.value === cmd.path && !cmd.args.includes(w));
}

/** A word whose value the alias reading can take as written: walking eval text expands anything else. */
function isPlainWord(token: Token): token is WordToken {
  return token.type === "word" && !token.dynamic && token.refs.length === 0 && token.subs.length === 0;
}

function spliced<T extends Token>(words: WordToken[], at: number, value: T[]): Array<WordToken | T> {
  return [...words.slice(0, at), ...value, ...words.slice(at + 1)];
}
