import type { SimpleCommand } from "../shell/commands.js";
import { isCaseUnsure } from "../shell/case-attrs.js";
import { splits } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { fieldKeyed, fieldValue, unreadable } from "./field-words.js";
import { ghApiRequest } from "./gh-api.js";
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

/** A run-time word no written non-dash text fixes as a positional, so its expansion may be `--base=main`. */
const mayHoldFlag = (word: WordToken) => unsure(word) && !/^[^-]/.test(literalPrefix(word));

/** A splitting word anywhere, or a positional only its expansion decides, may carry `--base main`; pflag keeps the last base. */
function editBase(leaf: WordToken[]): string | null {
  const options = readOptions(leaf, GH_PR_EDIT_VALUES);
  if (leaf.some((w) => splits(w)) || options.positionals.some(mayHoldFlag)) return UNKNOWN;
  const value = lastValue(options, "-B", "--base");
  if (!value) return null;
  return unsure(value) ? UNKNOWN : value.value.replace(/^=/, "");
}

/** A path cut short by a run-time word that may still read `pr edit`, with the rest of those words in the leaf. */
function hiddenEdit(path: string[], leaf: WordToken[]): boolean {
  const wanted = ["pr", "edit"];
  if (path.some((word, i) => word !== wanted[i])) return false;
  const missing = wanted.slice(path.length);
  const written = leaf.filter((w) => !w.dynamic).map((w) => w.value);
  return missing.every((word) => written.includes(word)) && written.some((v) => BASE_FLAG_RE.test(v));
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
 * query parameter, or an unread `--input` body. A run-time endpoint counts only when a field sets `base`.
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
  const base = fromFields ?? queryBase(req.endpoint) ?? input;
  if (base === null) return null;
  const pr = pull[1] ?? "";
  return { pr: /^\d+$/.test(pr) ? pr : null, base };
}
