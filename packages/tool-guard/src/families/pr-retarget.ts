import type { SimpleCommand } from "../shell/commands.js";
import { isCaseUnsure } from "../shell/case-attrs.js";
import { splits } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { expandsAtRunTime, fieldKeyed, fieldValue, unreadable } from "./field-words.js";
import { GH_API_VALUES, ghApiRequest } from "./gh-api.js";
import { ghCommandLine } from "./gh-words.js";
import { lastValue, readOptions, set } from "./options.js";

/** A PR moved onto `base`; `base` is "unknown" when it is known only at run time, which the caller treats as protected. */
interface PrRetarget {
  pr: string | null;
  base: string;
}

const UNKNOWN = "unknown";

/** gh 2.102 `gh pr edit` options that take a value; `--remove-milestone` is its one boolean besides `--help`. */
const GH_PR_EDIT_VALUES = set(
  "-B", "--base", "-b", "--body", "-F", "--body-file", "-t", "--title", "-m", "--milestone", "-R", "--repo", "--attach",
  "--add-assignee", "--remove-assignee", "--add-label", "--remove-label", "--add-project", "--remove-project",
  "--add-reviewer", "--remove-reviewer",
);
const BASE_FLAG_RE = /^(?:-B|--base)/;
const EDIT_PATH = ["pr", "edit"];

/** `repos/<o>/<r>/pulls/<n>` and nothing under it, so `pulls/N/merge` stays with the merge spelling. */
const PULL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+)?\/*(?:api\/v3\/)?repos\/[^/]+\/[^/]+\/pulls\/([^/?#]+)\/*(?:[?#].*)?$/i;

const unsure = (word: WordToken) => word.dynamic || isCaseUnsure(word);

/** The text before the first expansion; a computed or case-folded word has none that is known. */
function literalPrefix(word: WordToken): string {
  if (isCaseUnsure(word)) return "";
  if (!word.dynamic) return word.value;
  if (word.computed) return "";
  const starts = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at)];
  return word.value.slice(0, Math.min(word.value.length, ...starts));
}

/** A run-time word whose written text fixes its role, as gh-api's `readLeaf` reads it: `--name=…`, or a non-dash start. */
const fixedRole = (word: WordToken) => /^--[^=]+=|^[^-]/.test(literalPrefix(word));

/** Brace and glob expansion keep a word's leading plain text, so only a word led by other text may expand to a flag. */
const PLAIN_LEAD_RE = /^[A-Za-z0-9_./:@%+,]/;

/** A written word the shell may expand into several, one of them a flag: `-B{x,main}`, `{-fbase=main,x}`. */
const mayExpandToFlag = (word: WordToken) => !unsure(word) && expandsAtRunTime(word) && !PLAIN_LEAD_RE.test(word.value);

/** Whether pflag's next word is this option's value, given the options of `values` that take one. */
function takesNext(flag: string, values: ReadonlySet<string>): boolean {
  if (flag.startsWith("--")) return !flag.includes("=") && values.has(flag);
  if (!flag.startsWith("-")) return false;
  const at = [...flag].findIndex((c, i) => i > 0 && values.has(`-${c}`));
  return at === flag.length - 1;
}

/**
 * Whether the leaf may carry a flag pflag reads only at run time: a word that splits or expands into several, or a
 * run-time word where pflag reads a flag or positional and no written text fixes it as the latter. Past `--` pflag
 * reads only positionals.
 */
function mayCarryFlag(leaf: WordToken[], values: ReadonlySet<string>): boolean {
  let isValue = false;
  for (const word of leaf) {
    if (splits(word) || mayExpandToFlag(word)) return true;
    if (isValue) {
      isValue = false;
      continue;
    }
    if (unsure(word) && !fixedRole(word)) return true;
    if (word.value === "--") return false;
    isValue = takesNext(word.value, values);
  }
  return false;
}

/** pflag keeps the last base; its `-B=x` form strips one `=`. A base the shell may rewrite reads unknown. */
function editBase(leaf: WordToken[]): string | null {
  if (mayCarryFlag(leaf, GH_PR_EDIT_VALUES)) return UNKNOWN;
  const value = lastValue(readOptions(leaf, GH_PR_EDIT_VALUES), "-B", "--base");
  if (!value) return null;
  const branch = { ...value, value: value.value.replace(/^=/, "") };
  return unsure(branch) || expandsAtRunTime(branch) ? UNKNOWN : branch.value;
}

/**
 * A path cut short by a run-time word that may still read `pr edit`. Each command word not written in the leaf takes
 * one run-time word; a base flag written, a splitting word, or one more run-time word may then set the base.
 */
function hiddenEdit(path: string[], leaf: WordToken[]): boolean {
  if (path.some((word, i) => word !== EDIT_PATH[i])) return false;
  const written = leaf.filter((w) => !unsure(w)).map((w) => w.value);
  const unwritten = EDIT_PATH.slice(path.length).filter((word) => !written.includes(word)).length;
  const runTime = leaf.filter((w) => unsure(w) && !fixedRole(w)).length;
  return written.some((v) => BASE_FLAG_RE.test(v)) || leaf.some(splits) || runTime > unwritten;
}

/** `gh pr edit [<pr>] --base|-B <branch>`, or null when the command does not move a PR's base. */
export function prEditRetarget(cmd: SimpleCommand): PrRetarget | null {
  if (cmd.name !== "gh") return null;
  const line = ghCommandLine(cmd.args);
  if (line.hidden) return hiddenEdit(line.path, line.leaf) ? { pr: null, base: UNKNOWN } : null;
  if (line.path.join(" ") !== "pr edit") return null;
  const base = editBase(line.leaf);
  if (base === null) return null;
  const pr = readOptions(line.leaf, GH_PR_EDIT_VALUES).positionals[0];
  return { pr: pr && !pr.dynamic ? pr.value : null, base };
}

/** A field whose key may still read `base` at run time, directly or as gh's nested `a[b][base]`. */
function mayKeyBase(field: WordToken): boolean {
  const prefix = literalPrefix(field);
  const key = prefix.includes("=") ? prefix.slice(0, prefix.indexOf("=")) : prefix;
  return "base".startsWith(key) || key.includes("[");
}

function fieldBase(fields: WordToken[]): string | null {
  const keyed = fields.filter((f) => fieldKeyed(f, "base") === true).at(-1);
  if (keyed) return unreadable(keyed) ? UNKNOWN : fieldValue(keyed);
  return fields.some((f) => fieldKeyed(f, "base") === null && mayKeyBase(f)) ? UNKNOWN : null;
}

function queryBase(endpoint: string): string | null {
  const query = /\?([^#]*)/.exec(endpoint)?.[1];
  return query === undefined ? null : new URLSearchParams(query).get("base");
}

/**
 * `gh api` with a write method, stated or implied, to `repos/<o>/<r>/pulls/<n>` that sets `base`: a field, a `base=`
 * query parameter, an unread `--input` body, or a run-time word that may be `-f base=…`. A run-time endpoint counts
 * only when a field sets `base`.
 */
export function apiPullRetarget(cmd: SimpleCommand): PrRetarget | null {
  if (cmd.name !== "gh") return null;
  const line = ghCommandLine(cmd.args);
  if (line.hidden || line.path.join(" ") !== "api") return null;
  const req = ghApiRequest(line.leaf);
  if (req.method === "GET" || req.method === "HEAD") return null;
  const fromFields = fieldBase(req.fields);
  if (req.endpoint === null) return fromFields === null ? null : { pr: null, base: fromFields };
  const pull = PULL_RE.exec(req.endpoint);
  if (!pull) return null;
  const input = line.leaf.some((w) => /^--input(?:=|$)/.test(w.value)) ? UNKNOWN : null;
  const runTime = mayCarryFlag(line.leaf, GH_API_VALUES) ? UNKNOWN : null;
  const base = runTime ?? fromFields ?? queryBase(req.endpoint) ?? input;
  if (base === null) return null;
  const pr = pull[1] ?? "";
  return { pr: /^\d+$/.test(pr) ? pr : null, base };
}
