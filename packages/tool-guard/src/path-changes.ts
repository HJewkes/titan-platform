/**
 * Commands both bash and zsh run themselves, which no PATH lookup finds. The guard models both shells, so a name only one of
 * them has as a builtin (`print`, `mapfile`, `shopt`) is looked up on PATH in the other and is not listed.
 */
const BUILTINS: ReadonlySet<string> = new Set([
  ...[":", ".", "[", "[[", "alias", "bg", "break", "builtin", "cd", "command", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit"],
  ...["export", "false", "fc", "fg", "getopts", "hash", "jobs", "kill", "let", "local", "popd", "printf", "pushd", "pwd", "read", "readonly", "return", "set"],
  ...["shift", "source", "test", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait"],
]);

/** Whether a command name is one a PATH lookup resolves: a bare word that is no builtin of both shells. */
export function isPathSearched(name: string | null, path: string | null): boolean {
  return name !== null && path !== null && !path.includes("/") && !BUILTINS.has(name);
}
