/** An assignment to `PATH`, or to zsh's `path` array or an element of either, anywhere in the text: a prefix, `export`, an append, a dynamic value. */
const ASSIGN_RE = /(?:^|[^\w])(?:PATH|path)(?:\[[^\]]*\])?\+?=/;
/** Stores the walk's variable tracking does not read: zsh's `path` array, an element, and builtins that store into a named variable. */
const BLIND_RE =
  /(?:^|[^\w])path(?:\[[^\]]*\])?\+?=|(?:^|[^\w])PATH\[[^\]]*\]\+?=|\b(?:read|mapfile|readarray|getopts)\b[^;&|\n]*(?<![\w${])(?:PATH|path)\b|-v\s*(?:PATH|path)\b|\bset\s+-A\s+(?:PATH|path)\b|\b(?:for|select)\s+(?:PATH|path)\b/;

/** Whether a line may change the PATH a bare command name or an `env` shebang is looked up on. */
export function changesPath(src: string): boolean {
  return ASSIGN_RE.test(src) || BLIND_RE.test(src);
}

/** Whether a line stores into PATH in a way only its text shows (`path=(. $path)`, `read PATH`, `printf -v PATH`), whatever the walk read. */
export function storesPathBlind(src: string): boolean {
  return BLIND_RE.test(src);
}

/** Commands the shell runs itself, which no PATH lookup finds. */
const BUILTINS: ReadonlySet<string> = new Set([
  ...[":", ".", "[", "[[", "alias", "autoload", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "continue", "declare", "dirs"],
  ...["disown", "echo", "emulate", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "float", "functions", "getopts", "hash", "help", "history"],
  ...["integer", "jobs", "let", "local", "logout", "mapfile", "popd", "print", "printf", "pushd", "pwd", "read", "readarray", "readonly", "rehash", "return"],
  ...["set", "setopt", "shift", "shopt", "source", "test", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "unsetopt"],
  ...["vared", "wait", "whence", "where", "zmodload"],
]);

/** Whether a command name is one a PATH lookup resolves: a bare word that is no builtin. */
export function isPathSearched(name: string | null, path: string | null): boolean {
  return name !== null && path !== null && !path.includes("/") && !BUILTINS.has(name);
}
