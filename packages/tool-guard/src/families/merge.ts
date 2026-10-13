import type { SimpleCommand } from "../shell/commands.js";
import { isCaseUnsure } from "../shell/case-attrs.js";
import { parseGit, splits } from "../shell/git.js";
import type { GitInvocation } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { httpRequest, isWrite } from "./egress.js";
import { mayReachGitHubApi } from "./github-endpoint.js";
import { hasFlag, lastValue, readOptions, set, valuesOf } from "./options.js";

const PROTECTED_RE = /^(?:main|master|release\/.+)$/;
/** The Version Packages branch; merging it is a release, which the release family classifies. */
export const VERSION_PACKAGES_RE = /^(?:[^:]+:)?changeset-release\/main$/;
/** A current head that cannot be read because the directory is unknown; treated as protected. */
const UNKNOWN = "unknown";

const PULL_MERGE_RE = /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls\/([^/?]+)\/merge\/?(?:\?.*)?$/;
const MERGES_RE = /(?:^|\/)repos\/[^/]+\/[^/]+\/merges\/?(?:\?.*)?$/;
const GRAPHQL_MERGE_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/;

const GH_PR_MERGE_VALUES = set("-b", "--body", "-F", "--body-file", "-t", "--subject", "-R", "--repo", "--match-head-commit", "-A", "--author-email");
const GH_API_VALUES = set("-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "-p", "--preview", "--hostname", "--cache");
const GIT_MERGE_VALUES = set("-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "--into-name", "--cleanup");
const GIT_MERGE_CONTROL = ["--abort", "--continue", "--quit", "--skip"];
const GIT_PUSH_VALUES = set("--repo", "-o", "--push-option", "--receive-pack", "--exec");

export interface PrMerge {
  /** The PR number, URL or branch named, null for the current branch's PR. */
  target: WordToken | null;
}

/** `gh pr merge [<target>]`, or null when the command is not a merge; `--disable-auto` only cancels one. */
export function ghPrMerge(cmd: SimpleCommand): PrMerge | null {
  if (cmd.name !== "gh") return null;
  const options = readOptions(cmd.args, GH_PR_MERGE_VALUES);
  const [group, verb, target] = options.positionals;
  if (group?.value !== "pr" || verb?.value !== "merge" || hasFlag(options, "--disable-auto")) return null;
  return { target: target ?? null };
}

function prSubject(target: WordToken | null): Record<string, string> {
  const pr = target && !target.dynamic ? /^#?(\d+)$|\/pull\/(\d+)/.exec(target.value) : null;
  const number = pr?.[1] ?? pr?.[2];
  return number === undefined ? {} : { pr: number };
}

function prMerge(cmd: SimpleCommand): ClassifiedAction[] {
  const merge = ghPrMerge(cmd);
  if (!merge || (merge.target && VERSION_PACKAGES_RE.test(merge.target.value))) return [];
  return [classified("bash.merge.gh-pr-merge", prSubject(merge.target))];
}

/** `gh api`: gh sends POST when fields or `--input` are given without a method, GET otherwise. */
function apiMerge(cmd: SimpleCommand): ClassifiedAction[] {
  const options = readOptions(cmd.args, GH_API_VALUES);
  const [group, endpoint] = options.positionals;
  if (group?.value !== "api" || !endpoint) return [];
  const fields = valuesOf(options, "-f", "--raw-field", "-F", "--field");
  if (endpoint.value === "graphql") {
    const merges = fields.some((f) => !/^[^=]*=@/.test(f.value) && GRAPHQL_MERGE_RE.test(f.value));
    return merges ? [classified("bash.merge.gh-api-graphql", {})] : [];
  }
  const implied = fields.length > 0 || hasFlag(options, "--input") ? "POST" : "GET";
  const method = lastValue(options, "-X", "--method")?.value.toUpperCase() ?? implied;
  return endpointMerge(endpoint.value, method, "bash.merge.gh-api-merge", "bash.merge.gh-api-merges");
}

function endpointMerge(url: string, method: string, pullSpelling: SpellingId, mergesSpelling: SpellingId): ClassifiedAction[] {
  if (!isWrite(method)) return [];
  const pull = PULL_MERGE_RE.exec(url);
  if (pull) return [classified(pullSpelling, /^\d+$/.test(pull[1] ?? "") ? { pr: pull[1] as string } : {})];
  return MERGES_RE.test(url) ? [classified(mergesSpelling, {})] : [];
}

/** A literal endpoint names its PR, so it wins over a run-time URL that only may reach a merge endpoint. */
function curlMerge(cmd: SimpleCommand): ClassifiedAction[] {
  const request = httpRequest(cmd);
  if (!request) return [];
  const literal = request.urls.flatMap((u) => endpointMerge(u.value, request.method, "bash.merge.curl-api", "bash.merge.curl-api"));
  const runTime = isWrite(request.method) && request.urls.some(mayReachGitHubApi) ? [classified("bash.merge.curl-api", {})] : [];
  return [...literal, ...runTime].slice(0, 1);
}

/** Branch checked out where git runs; an unknown directory reads as `unknown`, which counts as protected. */
function headOf(git: GitInvocation, ctx: ClassifyContext): string | null {
  if (git.dir === null || git.otherPaths.length > 0) return UNKNOWN;
  try {
    return ctx.readHead(git.dir);
  } catch {
    return null;
  }
}

const isProtected = (branch: string | null) => branch !== null && (branch === UNKNOWN || PROTECTED_RE.test(branch));

/** Syncing a branch with its own upstream is not a merge into it. */
function isUpstream(ref: string, head: string): boolean {
  if (/^(?:[^@]*)@\{(?:u|upstream)\}$/.test(ref)) return true;
  return head !== UNKNOWN && (ref === `origin/${head}` || ref === `upstream/${head}` || ref === `refs/remotes/origin/${head}`);
}

function gitMerge(git: GitInvocation, ctx: ClassifyContext): ClassifiedAction[] {
  const options = readOptions(git.subArgs, GIT_MERGE_VALUES);
  if (hasFlag(options, ...GIT_MERGE_CONTROL) || options.positionals.length === 0) return [];
  const head = headOf(git, ctx);
  if (head === null || !isProtected(head)) return [];
  if (options.positionals.every((r) => !r.dynamic && !isCaseUnsure(r) && isUpstream(r.value, head))) return [];
  return [classified("bash.merge.git-merge-protected", { branch: head })];
}

/**
 * The branch a push refspec updates; `HEAD` and a bare name push to the branch of that name.
 * Git expands a short `heads/<x>` destination to `refs/heads/<x>`, so either prefix is stripped once.
 */
function pushDestination(spec: string, head: string | null): string | null {
  const plain = spec.replace(/^\+/, "");
  const colon = plain.lastIndexOf(":");
  const dest = (colon >= 0 ? plain.slice(colon + 1) : plain).replace(/^(?:refs\/)?heads\//, "");
  if (dest === "HEAD" || dest === "@") return colon >= 0 ? null : head;
  return dest === "" ? null : dest;
}

/**
 * A refspec's literal text; for `"$X":main` only the literal destination after the last colon is known.
 * A destination a case attribute may have changed may be any branch, so it reads as unknown.
 */
function literalSpec(word: WordToken): string | null {
  if (!word.dynamic && !isCaseUnsure(word)) return word.value;
  const typed = word.typed ?? word.value;
  const colon = refspecColon(typed);
  const tail = typed.slice(colon + 1);
  if (colon >= 0 && PLAIN_REF_RE.test(tail) && !cutAfterColon(word)) return `:${tail}`;
  return isCaseUnsure(word) ? `:${UNKNOWN}` : null;
}

const PLAIN_REF_RE = /^[\w./@+-]+$/;

/** `value` leaves out a `$(...)` or backquote's text, so `"HEAD:$(cmd)"` reads `HEAD:` though the output is the destination. */
const cutAfterColon = (word: WordToken) => (word.cuts ?? []).some((cut) => cut.at > refspecColon(word.value));

/** The last colon outside any `${...}`, `$(...)` or backquote, where `${B:-main}` and `${B:0:4}` hide colons of their own. */
function refspecColon(text: string): number {
  let depth = 0;
  let backquoted = false;
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const opens = c === "$" && (text[i + 1] === "{" || text[i + 1] === "(");
    if (opens) i++;
    if (c === "`") backquoted = !backquoted;
    else if (opens || (depth > 0 && (c === "{" || c === "("))) depth++;
    else if (depth > 0 && (c === "}" || c === ")")) depth--;
    else if (c === ":" && depth === 0 && !backquoted) found = i;
  }
  return found;
}

/**
 * A refspec known only at run time, or an unquoted dynamic word that may split into one, may name any branch,
 * so it reads as a push to an unknown destination.
 */
function hasUnknownDestination(git: GitInvocation, refspecs: WordToken[]): boolean {
  return git.subArgs.some((w) => splits(w) || expandsToMany(w)) || refspecs.some((s) => literalSpec(s) === null);
}

/** `"$@"` and `"${arr[@]}"`, with or without an operator such as `:0` or `#x`, give one word per element even when quoted, so any of them may be a refspec. */
const expandsToMany = (word: WordToken) => word.dynamic && /\$@|\$\{@|\[@\]/.test(word.typed ?? word.value);

function gitPush(git: GitInvocation, ctx: ClassifyContext): ClassifiedAction[] {
  const options = readOptions(git.subArgs, GIT_PUSH_VALUES);
  const refspecs = options.positionals.slice(1);
  const specs = refspecs.flatMap((s) => literalSpec(s) ?? []);
  if (hasFlag(options, "--all", "--branches", "--mirror") || specs.some((s) => s.includes("*"))) {
    return [classified("bash.merge.git-push-all", {})];
  }
  if (hasUnknownDestination(git, refspecs)) return pushSpecs([...specs, UNKNOWN], git, ctx);
  if (options.positionals.length > 1) return pushSpecs(specs, git, ctx);
  if (hasFlag(options, "--tags", "--delete", "-d")) return [];
  const head = headOf(git, ctx);
  return isProtected(head) ? [classified("bash.merge.git-push-implicit", { branch: head as string })] : [];
}

function pushSpecs(specs: string[], git: GitInvocation, ctx: ClassifyContext): ClassifiedAction[] {
  const needsHead = specs.some((s) => /^\+?(?:HEAD|@)$/.test(s));
  const head = needsHead ? headOf(git, ctx) : null;
  const dests = specs.map((s) => pushDestination(s, head)).filter(isProtected);
  return [...new Set(dests)].map((branch) => classified("bash.merge.git-push-protected", { branch: branch as string }));
}

function git(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const inv = parseGit(cmd.args, cmd.dir, ctx.home);
  if (inv.subDynamic) return [classified("bash.merge.git-push-protected", { branch: UNKNOWN })];
  if (inv.sub === "merge") return gitMerge(inv, ctx);
  return inv.sub === "push" ? gitPush(inv, ctx) : [];
}

function bash(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  if (cmd.name === "gh") return [...prMerge(cmd), ...apiMerge(cmd)];
  if (cmd.name === "git") return git(cmd, inChain(cmd, ctx));
  return curlMerge(cmd);
}

const NEW_BRANCH_OPTS = ["-b", "-B", "-c", "-C", "--orphan", "--create", "--force-create"];

/** The directory a branch switch acts in, null when unknown; undefined when `cmd` does not switch branch. */
function switchDir(cmd: SimpleCommand, ctx: ClassifyContext): { dir: string | null; created: WordToken | null } | undefined {
  if (cmd.name === "gh") {
    return /^pr checkout\b/.test(cmd.args.map((a) => a.value).join(" ")) ? { dir: cmd.dir, created: null } : undefined;
  }
  if (cmd.name !== "git") return undefined;
  const inv = parseGit(cmd.args, cmd.dir, ctx.home);
  if (inv.sub !== "checkout" && inv.sub !== "switch") return undefined;
  const dashes = inv.subArgs.findIndex((a) => a.value === "--");
  const options = readOptions(dashes >= 0 ? inv.subArgs.slice(0, dashes) : inv.subArgs, set(...NEW_BRANCH_OPTS));
  const created = lastValue(options, ...NEW_BRANCH_OPTS);
  if (!created && options.positionals.length === 0 && !hasFlag(options, "--detach")) return undefined;
  return { dir: inv.otherPaths.length > 0 ? null : inv.dir, created };
}

type Switch = { dir: string | null; created: WordToken | null };

/** The context `cmd` sees: a created branch trusted for its `&&` chain is dropped once the chain ends. */
function inChain(cmd: SimpleCommand, ctx: ClassifyContext): ClassifyContext {
  const held = ctx.chainTrust;
  return held && held.chain !== cmd.chain ? held.fallback : ctx;
}

/** Operators before a switch whose status the next `&&` may not see: `||` skips it, a pipe stage's status can be another's. */
const UNGUARDED_PREV = new Set(["||", "|", "|&"]);

/** Whether every later command in the chain runs only when the switch succeeded: joined by `&&`, not negated, not after `||` or a pipe. */
function guardsChain(cmd: SimpleCommand): boolean {
  return cmd.next === "&&" && !UNGUARDED_PREV.has(cmd.prev ?? "") && !cmd.negated;
}

/**
 * The head a branch switch leaves: a created branch's name when the switch is known to have succeeded or the
 * head it left was unprotected, since a failed `-b` (the branch exists) leaves that head checked out; otherwise `unknown`.
 */
function switchedHead(sw: Switch, succeeded: boolean, ctx: ClassifyContext): string {
  if (sw.dir === null || !sw.created || sw.created.dynamic || isCaseUnsure(sw.created)) return UNKNOWN;
  if (succeeded) return sw.created.value;
  return isProtected(headOf({ dir: sw.dir, otherPaths: [], config: [], sub: null, subDynamic: false, subArgs: [] }, ctx)) ? UNKNOWN : sw.created.value;
}

function switched(sw: Switch, head: string, ctx: ClassifyContext): ClassifyContext {
  return { ...ctx, readHead: (d) => (sw.dir === null || isProtected(head) || d === sw.dir ? head : ctx.readHead(d)) };
}

/**
 * A branch switch replaces the head later commands see: an unprotected new branch in its own directory only, any other
 * head everywhere. A created name is trusted outright only for the rest of an `&&` chain the switch guards.
 */
function after(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext | undefined {
  const ctx = inChain(cmd, line);
  const sw = switchDir(cmd, ctx);
  if (!sw) return ctx === line ? undefined : ctx;
  const base = ctx.chainTrust?.fallback ?? ctx;
  const fallback = switched(sw, switchedHead(sw, false, base), base);
  if (!guardsChain(cmd)) return fallback;
  return { ...switched(sw, switchedHead(sw, true, ctx), ctx), chainTrust: { chain: cmd.chain, fallback } };
}

/** Merging into a protected branch, by PR, API or git: the MRG rows of the authority table. */
export const merge: Family = { names: set("gh", "git", "curl", "wget", "http", "https"), bash, after };
