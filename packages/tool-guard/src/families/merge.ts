import type { Chain, SimpleCommand } from "../shell/commands.js";
import { parseGit } from "../shell/git.js";
import type { GitInvocation } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { httpRequest } from "./egress.js";
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
  if (method === "GET" || method === "HEAD") return [];
  const pull = PULL_MERGE_RE.exec(url);
  if (pull) return [classified(pullSpelling, /^\d+$/.test(pull[1] ?? "") ? { pr: pull[1] as string } : {})];
  return MERGES_RE.test(url) ? [classified(mergesSpelling, {})] : [];
}

function curlMerge(cmd: SimpleCommand): ClassifiedAction[] {
  const request = httpRequest(cmd);
  if (!request) return [];
  return request.urls.flatMap((u) => endpointMerge(u.value, request.method, "bash.merge.curl-api", "bash.merge.curl-api")).slice(0, 1);
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
  if (options.positionals.every((r) => !r.dynamic && isUpstream(r.value, head))) return [];
  return [classified("bash.merge.git-merge-protected", { branch: head })];
}

/** The branch a push refspec updates; `HEAD` and a bare name push to the branch of that name. */
function pushDestination(spec: string, head: string | null): string | null {
  const plain = spec.replace(/^\+/, "");
  const colon = plain.lastIndexOf(":");
  const dest = (colon >= 0 ? plain.slice(colon + 1) : plain).replace(/^refs\/heads\//, "");
  if (dest === "HEAD" || dest === "@") return colon >= 0 ? null : head;
  return dest === "" ? null : dest;
}

/** A refspec's literal text; for `"$X":main` only the literal destination after the last colon is known. */
function literalSpec(word: WordToken): string | null {
  if (!word.dynamic) return word.value;
  const tail = word.value.slice(word.value.lastIndexOf(":") + 1);
  return word.value.includes(":") && !/[$`]/.test(tail) ? `:${tail}` : null;
}

function gitPush(git: GitInvocation, ctx: ClassifyContext): ClassifiedAction[] {
  const options = readOptions(git.subArgs, GIT_PUSH_VALUES);
  const specs = options.positionals.slice(1).flatMap((s) => literalSpec(s) ?? []);
  if (hasFlag(options, "--all", "--branches", "--mirror") || specs.some((s) => s.includes("*"))) {
    return [classified("bash.merge.git-push-all", {})];
  }
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

/** Contexts that trust a created branch inside one `&&` chain, with the context every command outside it sees. */
const chainTrust = new WeakMap<ClassifyContext, { chain: Chain; fallback: ClassifyContext }>();

/** The context `cmd` sees: a created branch trusted for its `&&` chain is dropped once the chain ends. */
function inChain(cmd: SimpleCommand, ctx: ClassifyContext): ClassifyContext {
  const held = chainTrust.get(ctx);
  return held && held.chain !== cmd.chain ? held.fallback : ctx;
}

/** Whether every later command in the chain runs only when the switch succeeded: joined by `&&`, not negated, not run instead of a `||`. */
function guardsChain(cmd: SimpleCommand): boolean {
  return cmd.next === "&&" && cmd.prev !== "||" && !cmd.negated;
}

/**
 * The head a branch switch leaves: a created branch's name when the switch is known to have succeeded or the
 * head it left was unprotected, since a failed `-b` (the branch exists) leaves that head checked out; otherwise `unknown`.
 */
function switchedHead(sw: Switch, succeeded: boolean, ctx: ClassifyContext): string {
  if (sw.dir === null || !sw.created || sw.created.dynamic) return UNKNOWN;
  if (succeeded) return sw.created.value;
  return isProtected(headOf({ dir: sw.dir, otherPaths: [], config: [], sub: null, subArgs: [] }, ctx)) ? UNKNOWN : sw.created.value;
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
  const base = chainTrust.get(ctx)?.fallback ?? ctx;
  const fallback = switched(sw, switchedHead(sw, false, base), base);
  if (!guardsChain(cmd)) return fallback;
  const trusted = switched(sw, switchedHead(sw, true, ctx), ctx);
  chainTrust.set(trusted, { chain: cmd.chain, fallback });
  return trusted;
}

/** Merging into a protected branch, by PR, API or git: the MRG rows of the authority table. */
export const merge: Family = { names: set("gh", "git", "curl", "wget", "http", "https"), bash, after };
