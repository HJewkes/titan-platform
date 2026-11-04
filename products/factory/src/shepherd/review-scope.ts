import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { isRepoKey } from "./seats.js";
import {
  BranchName,
  CarryRefusal,
  carryCacheDir,
  carryStateDir,
  ensureCache,
  fetchArgs,
  githubRemote,
  isAncestor,
  must,
  reasonOf,
  remoteBase,
  serialized,
  systemGit,
  type CarryOptions,
  type Git,
} from "./tree-carry.js";

/** Which part of a fix-round head a re-review may read as the fix (TP-3735); a refusal means a full review, never a skipped one. */
export const REVIEW_SCOPE_STEP = "sh-review-scope";
const SCOPE_MAX_LINES = 400;
const SCOPE_MAX_PATHS = 40;

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const ScopeInputSchema = z
  .object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, sinceHead: Sha, head: Sha })
  .refine((input) => input.sinceHead !== input.head, "sinceHead must differ from head");
type ReviewScopeInput = z.infer<typeof ScopeInputSchema>;

/** Changed lines at the head: `count` lines from `start`, or for `count` 0 a pure deletion just after line `start`, as `git diff -U0` writes them. */
const HunkSchema = z.object({ path: z.string(), start: z.number().int(), count: z.number().int() });
type ScopeHunk = z.infer<typeof HunkSchema>;

const ScopedSchema = z.object({
  scoped: z.literal(true),
  sinceHead: Sha,
  /** The fixer merged a base commit the reviewed head lacked, so the reviewer's own `git diff sinceHead head` also shows main's edits. */
  mergedBase: z.boolean(),
  paths: z.array(z.string()),
  hunks: z.array(HunkSchema),
  changedLines: z.number().int(),
});
const FullSchema = z.object({ scoped: z.literal(false), reason: z.string() });
const ReviewScopeResultSchema = z.discriminatedUnion("scoped", [ScopedSchema, FullSchema]);
export type ReviewScopeResult = z.infer<typeof ReviewScopeResultSchema>;
type Full = z.infer<typeof FullSchema>;
type ScopeDiff = Pick<z.infer<typeof ScopedSchema>, "paths" | "hunks" | "changedLines">;

const full = (reason: string): Full => ({ scoped: false, reason });

interface FileStat {
  path: string;
  lines: number;
}

/** `git diff --numstat -z` records; a binary file (`-` counts) changes no lines but is still a fix path. */
function parseNumstat(numstat: string): FileStat[] {
  return numstat
    .split("\0")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [added = "", deleted = "", ...rest] = record.split("\t");
      return { path: rest.join("\t"), lines: (Number(added) || 0) + (Number(deleted) || 0) };
    });
}

/** The brief interpolates paths into shell lines, and PR authors choose file names; same refusal set as the brief's checkout path, plus the single quote. */
const SHELL_ACTIVE = /["'$`\\]/;
const hasControlChar = (path: string): boolean => [...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
const unsafePath = (path: string): boolean => path === "" || SHELL_ACTIVE.test(path) || hasControlChar(path);

/** The reason is a stored output that can reach a public PR, so it never echoes a path. */
function filesRefusal(files: readonly FileStat[]): Full | undefined {
  const changedLines = files.reduce((sum, file) => sum + file.lines, 0);
  if (files.length === 0) return full("no change since the reviewed head");
  if (changedLines > SCOPE_MAX_LINES) return full(`${changedLines} changed lines, over ${SCOPE_MAX_LINES}`);
  if (files.length > SCOPE_MAX_PATHS) return full(`${files.length} changed paths, over ${SCOPE_MAX_PATHS}`);
  if (files.some((file) => unsafePath(file.path))) return full("a changed path has a shell-active character");
  return undefined;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** A header path git quoted holds a quote, backslash or control byte (or a non-ASCII byte), so it is refused rather than unquoted. */
function headerPath(line: string): string | undefined {
  const name = line.slice(4).replace(/\t$/, "");
  if (name === "/dev/null") return "";
  if (name.startsWith('"') || !/^[ab]\//.test(name)) return undefined;
  return name.slice(2);
}

/** A deleted file's head side is `/dev/null`, so its hunks are filed under the old path. */
const newPath = (path: string | undefined, oldPath: string | undefined): string | undefined => (path === "" ? oldPath || undefined : path);

/** Only `---`/`+++` lines between `diff --git` and the first `@@` are headers; a removed line reading `-- x` would otherwise look like one. */
function parseHunks(unifiedZero: string): ScopeHunk[] | Full {
  const hunks: ScopeHunk[] = [];
  let inHeader = false;
  let oldPath: string | undefined;
  let path: string | undefined;
  for (const line of unifiedZero.split("\n")) {
    if (line.startsWith("diff --git ")) [inHeader, oldPath, path] = [true, undefined, undefined];
    else if (inHeader && line.startsWith("--- ")) oldPath = headerPath(line);
    else if (inHeader && line.startsWith("+++ ")) path = newPath(headerPath(line), oldPath);
    else if (line.startsWith("@@")) {
      inHeader = false;
      const match = HUNK_HEADER.exec(line);
      if (match === null || path === undefined) return full("the fix diff has a header it cannot read");
      hunks.push({ path, start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) });
    }
  }
  return hunks;
}

/** The fix's paths, changed lines and head-side ranges, or why the round must read the whole PR. */
export function scopeFromDiff(numstat: string, unifiedZero: string): ScopeDiff | Full {
  const files = parseNumstat(numstat);
  const refused = filesRefusal(files);
  if (refused) return refused;
  const hunks = parseHunks(unifiedZero);
  if (!Array.isArray(hunks)) return hunks;
  const paths = files.map((file) => file.path);
  if (hunks.some((hunk) => !paths.includes(hunk.path))) return full("the fix diff names a path its numstat does not");
  return { paths, hunks, changedLines: files.reduce((sum, file) => sum + file.lines, 0) };
}

const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];

/** The numstat is read first, so an over-cap diff never has its full text read. */
async function fixDiff(git: Git, dir: string, from: string, to: string, signal?: AbortSignal): Promise<ScopeDiff | Full> {
  const numstat = await git(dir, [...DIFF_ARGS, "--numstat", "-z", from, to], signal);
  if (numstat.code !== 0) throw new CarryRefusal("diff", numstat.code);
  const early = filesRefusal(parseNumstat(numstat.stdout));
  if (early) return early;
  const unified = await must(git, dir, [...DIFF_ARGS, "-U0", from, to], signal);
  return scopeFromDiff(numstat.stdout, unified);
}

/** The fix diff runs from the reviewed head merged with the base the head contains, so main's changes a merge brought in drop out. */
async function probe(git: Git, dir: string, url: string, input: ReviewScopeInput, signal?: AbortSignal): Promise<ReviewScopeResult> {
  const { sinceHead, head } = input;
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, { ...input, fromHead: sinceHead }), signal);
  if (!(await isAncestor(git, dir, sinceHead, head, signal))) return full(`${head} does not contain ${sinceHead}, so it is a rebase, not a fix on top`);
  const base = await must(git, dir, ["merge-base", head, remoteBase(input.baseRef)], signal);
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", sinceHead, base], signal);
  if (merged.code === 1) return full(`${sinceHead} conflicts with ${base}`);
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = merged.stdout.trim().split("\n")[0] ?? "";
  const sinceBase = await must(git, dir, ["merge-base", sinceHead, base], signal);
  const diff = await fixDiff(git, dir, mergeTree, head, signal);
  return "reason" in diff ? diff : { scoped: true, sinceHead, mergedBase: base !== sinceBase, ...diff };
}

/** Any failure, from bad input to a refused fetch, answers a full review with a fixed-vocabulary reason. */
export async function reviewScope(raw: unknown, options: CarryOptions = {}): Promise<ReviewScopeResult> {
  const parsed = ScopeInputSchema.safeParse(raw);
  if (!parsed.success) return full(`invalid review-scope input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => probe(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return full(reasonOf(error));
  }
}

export function reviewScopeRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(REVIEW_SCOPE_STEP, now, (input: unknown, signal) => reviewScope(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded scope, and a moved head gets its own step. */
export async function reviewScopeStep(ctx: WorkflowContext, input: ReviewScopeInput): Promise<ReviewScopeResult> {
  return step(ctx, `${REVIEW_SCOPE_STEP}:${input.head}`, input, ReviewScopeResultSchema);
}
