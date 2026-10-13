import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";

/** The GraphQL mutations that move a branch ref, as named in GitHub's schema. */
const BRANCH_MUTATION_RE =
  /\b(updateRefs|updateRef|createRef|deleteRef|mergeBranch|createCommitOnBranch|enqueuePullRequest|createLinkedBranch|updatePullRequestBranch)\b/g;
/** Their target is an opaque ref id or a PR's base or head branch, which the text cannot show. */
const OPAQUE_TARGET = new Set(["updateRef", "deleteRef", "enqueuePullRequest", "updatePullRequestBranch"]);
/** Their target branch is written in the text or a variable. */
const NAMED_TARGET = new Set(["updateRefs", "createRef", "mergeBranch", "createCommitOnBranch", "createLinkedBranch"]);
/** The input key that must carry the branch, where the schema lets the call leave it out. */
const TARGET_KEY: Record<string, string> = { createCommitOnBranch: "branchName", createLinkedBranch: "name" };

/** The escape layers GitHub decodes: a JSON body, then a GraphQL string inside it. */
const DECODED_LAYERS = 2;
const ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

interface GraphqlBranchWrites {
  /** The branch mutations the query texts name, in order of first appearance. */
  mutations: string[];
  /** Candidate branch names, with one `refs/` and one `heads/` stripped; the caller tests each for protection. */
  branches: string[];
  /**
   * A mutation's target branch is known only at run time, or a text is escaped past the two layers GitHub decodes;
   * the second can hold with `mutations` empty.
   */
  unknown: boolean;
}

function decodeEscape(match: string, braced?: string, hex?: string, simple?: string): string {
  if (simple !== undefined) return SIMPLE_ESCAPES[simple] ?? match;
  const digits = braced ?? hex;
  if (digits === undefined) return match;
  const code = Number.parseInt(digits, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

interface DecodedText {
  /** The text with at most the two escape layers GitHub decodes removed. */
  text: string;
  /** Whether no escape is left to decode; false when a third layer would still change `text`. */
  complete: boolean;
}

/**
 * Decodes JSON and GraphQL string escapes, the two layers an `--input` body carries. Each pass peels one layer, so
 * the cap keeps a crafted chain of escapes from costing quadratic time; a mutation name, which GitHub reads outside
 * any string, already shows in the text the cap leaves.
 */
export function decodeGraphqlEscapes(text: string): DecodedText {
  let current = text;
  for (let pass = 0; pass < DECODED_LAYERS; pass++) {
    const next = current.replace(ESCAPE_RE, decodeEscape);
    if (next === current) return { text: current, complete: true };
    current = next;
  }
  return { text: current, complete: current.replace(ESCAPE_RE, decodeEscape) === current };
}

/**
 * `key` written as an object key: GraphQL `key:` or JSON `"key":`, with commas or spaces before the colon. A comment
 * there is not followed to its colon, which would cost quadratic time over many commented keys: an `id` key counts
 * as written once a comment follows it, and any other key as unwritten, which both read the target as unknown.
 */
const objectKeyRe = (key: string) => new RegExp(`\\b${key}"?[\\s,]*${key === "id" ? "[:#]" : ":"}`);

/** A field word's key before its first `=`: `key` itself, or `key` as any bracket segment of gh's nested `a[b][key]` form. */
const fieldKeyRe = (key: string) => new RegExp(`^(?:${key}|[^=]*\\[${key}\\])=`);

const normalizeBranch = (name: string) => name.trim().replace(/^refs\//, "").replace(/^heads\//, "");

/**
 * Every run of text between two double quotes: each GraphQL or JSON string, `"""block"""` strings included, whatever
 * comments or escaped quotes would do to a real lexer's alignment. The gaps between strings come along; they are harmless.
 */
const quotedRuns = (text: string) => text.split('"').slice(1, -1);

/** Whether a field word's key, before its first `=`, is the literal `query`, which carries the texts themselves. */
function isQueryField(word: WordToken): boolean {
  if (!word.value.startsWith("query=")) return false;
  const literalKey = (at: number) => at >= "query".length;
  return word.refs.every((r) => literalKey(r.start)) && (word.cuts ?? []).every((c) => literalKey(c.at));
}

/** A variable whose value cannot be read: computed at run time, case-folded, or read from a file. */
function unreadable(word: WordToken): boolean {
  return word.dynamic || isCaseUnsure(word) || /^[^=]*=@/.test(word.value);
}

function fieldValue(word: WordToken): string {
  const eq = word.value.indexOf("=");
  return eq >= 0 ? word.value.slice(eq + 1) : word.value;
}

function mutationsIn(texts: string[]): string[] {
  const found = texts.flatMap((t) => [...t.matchAll(BRANCH_MUTATION_RE)].map((m) => m[0]));
  return [...new Set(found)];
}

const keyed = (key: string, texts: string[], variables: WordToken[]) =>
  texts.some((t) => objectKeyRe(key).test(t)) || variables.some((w) => fieldKeyRe(key).test(w.value));

/**
 * A mutation that may leave its branch out is known only when the branch key is written and no `id` key is: a
 * `CommittableBranch` names its branch by `id` or by `branchName`, and any `id` anywhere may be that one.
 */
function targetUnwritten(mutations: string[], texts: string[], variables: WordToken[]): boolean {
  const keys = mutations.flatMap((m) => TARGET_KEY[m] ?? []);
  if (keys.length === 0) return false;
  return keyed("id", texts, variables) || keys.some((k) => !keyed(k, texts, variables));
}

function candidateBranches(texts: string[], variables: WordToken[]): string[] {
  const values = variables.filter((w) => !unreadable(w)).map(fieldValue);
  const names = [...texts.flatMap(quotedRuns), ...values, ...values.flatMap(quotedRuns)].map(normalizeBranch);
  return [...new Set(names)].filter((n) => n !== "");
}

/**
 * The GitHub GraphQL mutations in `texts` that move a branch ref, and the branches they may name. `texts` are the
 * query texts a call sends; `fields` are its `-f`/`-F` words, `query=` among them. The reading is deliberately coarse:
 * any quoted string or literal variable in a call naming a mutation with a written target counts as a branch it may write.
 */
export function graphqlBranchWrites(texts: string[], fields: WordToken[]): GraphqlBranchWrites {
  const reads = texts.map(decodeGraphqlEscapes);
  const capped = reads.some((r) => !r.complete);
  const decoded = reads.map((r) => r.text);
  const mutations = mutationsIn(decoded);
  if (mutations.length === 0) return { mutations, branches: [], unknown: capped };
  const variables = fields.filter((w) => !isQueryField(w));
  const unknown =
    capped || mutations.some((m) => OPAQUE_TARGET.has(m)) || targetUnwritten(mutations, decoded, variables) || variables.some(unreadable);
  const named = mutations.some((m) => NAMED_TARGET.has(m));
  return { mutations, branches: named ? candidateBranches(decoded, variables) : [], unknown };
}
