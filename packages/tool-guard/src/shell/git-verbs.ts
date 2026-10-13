/**
 * Subcommands git itself provides: `git --list-cmds=builtins,main` from git 2.53, kept static
 * because tool-guard cannot run git. Git runs these before any alias, so a word here runs as
 * itself. With help.autocorrect on, git's `help.c` runs its closest guess, alias or verb, for
 * any other word, so `git psuh` can push. Optional externals (svn, p4, lfs, send-email and the
 * like) stay off: when one is not installed, git autocorrects it to a near alias instead.
 * Case is exact: on a case-insensitive filesystem git runs `git-PUSH` without the classifier
 * ever seeing `push`, so `PUSH` has to stay unknown.
 */
export const GIT_VERBS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archive", "backfill", "bisect", "blame", "branch",
  "bugreport", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap",
  "check-ref-format", "checkout", "checkout--worker", "checkout-index", "cherry", "cherry-pick",
  "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects",
  "credential", "credential-cache", "credential-cache--daemon", "credential-store", "daemon",
  "describe", "diagnose", "diff", "diff-files", "diff-index", "diff-pairs", "diff-tree",
  "difftool", "difftool--helper", "fast-export", "fast-import", "fetch", "fetch-pack",
  "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck",
  "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "hash-object", "help",
  "hook", "http-backend", "http-fetch", "http-push", "imap-send", "index-pack", "init",
  "init-db", "instaweb", "interpret-trailers", "last-modified", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
  "merge-index", "merge-octopus", "merge-one-file", "merge-ours", "merge-recursive",
  "merge-recursive-ours", "merge-recursive-theirs", "merge-resolve", "merge-subtree",
  "merge-tree", "mergetool", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes",
  "pack-objects", "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune", "prune-packed",
  "pull", "push", "quiltimport", "range-diff", "read-tree", "rebase", "receive-pack", "reflog",
  "refs", "remote", "remote-ext", "remote-fd", "remote-ftp", "remote-ftps", "remote-http",
  "remote-https", "repack", "replace", "replay", "repo", "request-pull", "rerere", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "send-pack", "sh-i18n--envsubst", "shell",
  "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage",
  "stash", "status", "stripspace", "submodule", "submodule--helper", "subtree", "switch",
  "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-archive--writer", "upload-pack", "var",
  "verify-commit", "verify-pack", "verify-tag", "version", "web--browse", "whatchanged",
  "worktree", "write-tree",
]);

/**
 * Reads a subcommand word. `verb` is the word guarded classifiers should check; `known` says
 * git runs exactly that verb. Bash keeps a CR inside the word, and autocorrect may run
 * `push\r` as `push`, so trailing CRs are stripped from `verb`. A stripped word stays
 * unknown, because a nearer alias such as `pushx` would win the autocorrect instead.
 */
export function readGitVerb(word: string): { verb: string; known: boolean } {
  if (GIT_VERBS.has(word)) return { verb: word, known: true };
  const stripped = word.replace(/\r+$/, "");
  return { verb: GIT_VERBS.has(stripped) ? stripped : word, known: false };
}

/** git `strcmp`s these, so their case is exact. */
const OFF_WORDS = new Set(["never", "show"]);
/** git's boolean parser folds case for these. */
const OFF_BOOLEANS = new Set(["0", "false", "no", "off"]);

/**
 * Whether the command's own `-c` overrides turn help.autocorrect off. The last entry wins,
 * as in git. With no entry the user's config decides, which tool-guard cannot see, so it
 * counts as on. Only `-c` is read: a `--config-env` on the same line can still turn it on.
 */
export function autocorrectOff(config: readonly string[]): boolean {
  const entry = [...config].reverse().find((item) => configKey(item).toLowerCase() === "help.autocorrect");
  if (entry === undefined) return false;
  const eq = entry.indexOf("=");
  if (eq < 0) return false;
  const value = entry.slice(eq + 1);
  return OFF_WORDS.has(value) || OFF_BOOLEANS.has(value.toLowerCase());
}

const configKey = (item: string) => {
  const eq = item.indexOf("=");
  return eq < 0 ? item : item.slice(0, eq);
};
