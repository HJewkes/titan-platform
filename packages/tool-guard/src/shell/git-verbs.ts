/**
 * Subcommands git runs as themselves. With help.autocorrect on, git's `help.c` runs its
 * closest guess for any other word, so `git psuh` can push. tool-guard cannot read the
 * user's git config, so a word off this table must be treated as possibly any verb.
 * Case is exact: on a case-insensitive filesystem git runs `git-PUSH` without the
 * classifier ever seeing `push`, so `PUSH` has to stay unknown.
 *
 * Built from `git --list-cmds=builtins,main,others` and the foreign-SCM entries of
 * `git help -a` (git 2.53), plus `lfs` and `filter-repo` as common externals.
 */
export const GIT_VERBS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archimport", "archive", "backfill", "bisect", "blame",
  "branch", "bugreport", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap",
  "check-ref-format", "checkout", "checkout--worker", "checkout-index", "cherry", "cherry-pick",
  "citool", "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config",
  "count-objects", "credential", "credential-cache", "credential-cache--daemon", "credential-store",
  "cvsexportcommit", "cvsimport", "cvsserver", "daemon", "describe", "diagnose", "diff",
  "diff-files", "diff-index", "diff-pairs", "diff-tree", "difftool", "difftool--helper",
  "fast-export", "fast-import", "fetch", "fetch-pack", "filter-branch", "filter-repo",
  "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck", "fsck-objects",
  "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "gui", "hash-object", "help", "hook",
  "http-backend", "http-fetch", "http-push", "imap-send", "index-pack", "init", "init-db",
  "instaweb", "interpret-trailers", "last-modified", "lfs", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
  "merge-index", "merge-octopus", "merge-one-file", "merge-ours", "merge-recursive",
  "merge-recursive-ours", "merge-recursive-theirs", "merge-resolve", "merge-subtree", "merge-tree",
  "mergetool", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes", "p4",
  "pack-objects", "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune", "prune-packed",
  "pull", "push", "quiltimport", "range-diff", "read-tree", "rebase", "receive-pack", "reflog",
  "refs", "remote", "remote-ext", "remote-fd", "remote-ftp", "remote-ftps", "remote-http",
  "remote-https", "repack", "replace", "replay", "repo", "request-pull", "rerere", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "send-pack", "sh-i18n--envsubst",
  "shell", "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage",
  "stash", "status", "stripspace", "submodule", "submodule--helper", "subtree", "svn", "switch",
  "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-archive--writer", "upload-pack", "var",
  "verify-commit", "verify-pack", "verify-tag", "version", "web--browse", "whatchanged", "worktree",
  "write-tree",
]);

/**
 * Reads a subcommand word. Bash keeps a CR inside the word, and autocorrect turns
 * `push\r` back into `push`, so a known verb with trailing CRs reads as that verb.
 */
export function readGitVerb(word: string): { verb: string; known: boolean } {
  if (GIT_VERBS.has(word)) return { verb: word, known: true };
  const stripped = word.replace(/\r+$/, "");
  if (stripped !== word && GIT_VERBS.has(stripped)) return { verb: stripped, known: true };
  return { verb: word, known: false };
}

/** git `strcmp`s these, so their case is exact. */
const OFF_WORDS = new Set(["never", "show"]);
/** git's boolean parser folds case for these. */
const OFF_BOOLEANS = new Set(["0", "false", "no", "off"]);

/**
 * Whether the command's own `-c` overrides turn help.autocorrect off. The last entry wins,
 * as in git. With no entry the user's config decides, which tool-guard cannot see, so it
 * counts as on.
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
