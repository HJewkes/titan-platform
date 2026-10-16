import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";
import { set } from "./options.js";
import type { Option } from "./options.js";

/** gh 2.102 `gh api` options that take a value; pflag knows the rest as booleans, and rejects any other flag. */
export const GH_API_VALUES = set("-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "-p", "--preview", "--hostname", "--cache");

const FIELD_FLAGS = ["-f", "--raw-field", "-F", "--field"];
const METHOD_FLAGS = ["-X", "--method"];

/** What a `gh api` call requests, read fail-closed: null means known only at run time. */
export interface GhApiRequest {
  endpoint: string | null;
  /** Upper-cased; gh sends POST when fields or `--input` are given without a method, GET otherwise. */
  method: string | null;
  fields: WordToken[];
  /** The endpoint may be `graphql` and the query is known only at run time. */
  queryUnknown: boolean;
  /** The endpoint word word-splits, so under bash it can carry more words, `-X PUT` among them. */
  endpointSplits: boolean;
}

/** A word pflag reads as a positional; `unknown` when only its expansion decides whether it is a flag instead. */
interface Slot {
  index: number;
  word: WordToken;
  unknown: boolean;
}

interface LeafReading {
  opts: Option[];
  slots: Slot[];
}

/** Bash's default IFS whitespace; tool-guard does not track an IFS the line sets. */
const IFS_WHITESPACE = /[ \t\n]/;

/** A path gh or GitHub resolves to the graphql endpoint: bare, rooted, a full URL, GHES's `api/`, or with a query. */
const GRAPHQL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+)?\/*(?:api\/)?graphql\/*(?:[?#].*)?$/i;

/**
 * An unquoted expansion word-splits: an unknown one may carry more words, and a resolved one does when its value
 * holds IFS whitespace or is empty, which drops the word.
 */
function splits(word: WordToken | null | undefined): boolean {
  if (!word) return false;
  if (word.dynamic) return !word.quoted || word.unquotedExpansion === true;
  return word.unquotedExpansion === true && (word.value === "" || IFS_WHITESPACE.test(word.value));
}

export const isGraphqlEndpoint = (endpoint: string) => GRAPHQL_RE.test(endpoint);

const unsure = (word: WordToken | null | undefined) => Boolean(word && (word.dynamic || isCaseUnsure(word)));

/** The text before the first expansion; a computed word records no positions, so none of it is known. */
function literalPrefix(word: WordToken): string {
  if (isCaseUnsure(word)) return "";
  if (!word.dynamic) return word.value;
  if (word.computed) return "";
  const starts = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at)];
  return word.value.slice(0, Math.min(word.value.length, ...starts));
}

/** The part of `word` from `at` on, its expansion positions moved to match. */
function suffix(word: WordToken, at: number): WordToken {
  const refs = word.refs.map((r) => ({ ...r, start: r.start - at, end: r.end - at }));
  const cuts = word.cuts?.map((c) => ({ ...c, at: c.at - at }));
  return { ...word, value: word.value.slice(at), refs, ...(cuts ? { cuts } : {}) };
}

/** `--name=value` with a written name, else a long flag that takes the next word when `values` names it. */
function readLong(word: WordToken, next: WordToken | undefined, opts: Option[]): number {
  const eq = literalPrefix(word).indexOf("=");
  if (eq > 0) {
    opts.push({ flag: word.value.slice(0, eq), value: suffix(word, eq + 1) });
    return 0;
  }
  const takes = GH_API_VALUES.has(word.value);
  opts.push({ flag: word.value, value: takes ? (next ?? null) : null });
  return takes ? 1 : 0;
}

/** A cluster such as `-iXPUT`: the first letter that takes a value consumes the rest, or the next word. */
function readShort(word: WordToken, next: WordToken | undefined, opts: Option[]): number {
  for (let j = 1; j < word.value.length; j++) {
    const flag = `-${word.value[j]}`;
    if (!GH_API_VALUES.has(flag)) {
      opts.push({ flag, value: null });
      continue;
    }
    if (j < word.value.length - 1) {
      opts.push({ flag, value: suffix(word, j + 1) });
      return 0;
    }
    opts.push({ flag, value: next ?? null });
    return 1;
  }
  return 0;
}

/**
 * Reads the leaf as pflag does. A dynamic word reads as written only where its written prefix fixes its role:
 * `--name=` names that option, and any non-dash start is a positional. Elsewhere its expansion may be a flag.
 */
function readLeaf(leaf: WordToken[]): LeafReading {
  const out: LeafReading = { opts: [], slots: [] };
  let skip = 0;
  for (const [i, word] of leaf.entries()) {
    if (skip > 0) {
      skip--;
      continue;
    }
    const prefix = literalPrefix(word);
    const known = !unsure(word) || /^--[^=]+=/.test(prefix) || /^[^-]/.test(prefix);
    if (!known) out.slots.push({ index: i, word, unknown: true });
    else if (word.value === "--") {
      out.slots.push(...leaf.slice(i + 1).map((w, k) => ({ index: i + 1 + k, word: w, unknown: false })));
      break;
    } else if (word.value.startsWith("--")) skip = readLong(word, leaf[i + 1], out.opts);
    else if (word.value.startsWith("-") && word.value.length > 1) skip = readShort(word, leaf[i + 1], out.opts);
    else out.slots.push({ index: i, word, unknown: false });
  }
  return out;
}

/** The first slot, unless it may be a flag, splits, or a splitting word before it may carry the endpoint. */
function endpointOf(reading: LeafReading, leaf: WordToken[]): string | null {
  const first = reading.slots[0];
  if (!first || unsure(first.word) || splits(first.word) || leaf.slice(0, first.index).some(splits)) return null;
  return first.word.value;
}

/** An unknown slot is the endpoint only when it is the one positional gh accepts; any other may be `-X PUT`. */
const mayHoldFlag = (reading: LeafReading) => reading.slots.length > 1 && reading.slots.some((s) => s.unknown);

/**
 * A splitting word may carry `-X` or `-f query=…`. An unknown endpoint word's own splitting is `endpointSplits`
 * instead; a resolved one is known to carry more words.
 */
function carriesWords(reading: LeafReading, leaf: WordToken[]): boolean {
  const endpoint = reading.slots[0];
  return leaf.some((w, i) => splits(w) && !(i === endpoint?.index && w.dynamic));
}

function methodOf(reading: LeafReading, leaf: WordToken[], fields: WordToken[]): string | null {
  if (mayHoldFlag(reading) || carriesWords(reading, leaf)) return null;
  const given = reading.opts.filter((o) => METHOD_FLAGS.includes(o.flag)).at(-1);
  if (given) return given.value && !unsure(given.value) ? given.value.value.toUpperCase() : null;
  return fields.length > 0 || reading.opts.some((o) => o.flag === "--input") ? "POST" : "GET";
}

/** A dynamic `query=` field, or one whose written key may still become `query`; an `@file` read stays unread. */
function queryFieldUnknown(field: WordToken): boolean {
  if (!unsure(field)) return false;
  const prefix = literalPrefix(field);
  const eq = prefix.indexOf("=");
  if (eq < 0) return "query".startsWith(prefix);
  return prefix.slice(0, eq) === "query" && !prefix.slice(eq + 1).startsWith("@");
}

/**
 * Reads a `gh api` call's leaf: its args with the command words removed, as cobra passes them to pflag.
 * On a possible graphql endpoint, a slot that may be a flag or a splitting word may carry `-f query=…`.
 */
export function ghApiRequest(leaf: WordToken[]): GhApiRequest {
  const reading = readLeaf(leaf);
  const fields = reading.opts.flatMap((o) => (FIELD_FLAGS.includes(o.flag) && o.value ? [o.value] : []));
  const endpoint = endpointOf(reading, leaf);
  return {
    endpoint,
    method: methodOf(reading, leaf, fields),
    fields,
    queryUnknown: (endpoint === null || isGraphqlEndpoint(endpoint)) && (mayHoldFlag(reading) || carriesWords(reading, leaf) || fields.some(queryFieldUnknown)),
    endpointSplits: splits(reading.slots[0]?.word),
  };
}
