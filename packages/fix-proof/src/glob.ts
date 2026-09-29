const MAX_EXPANSIONS = 256;
const INNERMOST_BRACE = /\{([^{}]*)\}/;

/** Every alternative of a brace glob, innermost group first; throws past 256 alternatives. */
export function expandBraces(glob: string): string[] {
  const match = INNERMOST_BRACE.exec(glob);
  if (!match) return [glob];
  const [group, body = ""] = match;
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + group.length);
  const expanded = body.split(",").flatMap((choice) => expandBraces(head + choice + tail));
  if (expanded.length > MAX_EXPANSIONS) throw new Error(`glob expands past ${MAX_EXPANSIONS} alternatives: ${glob}`);
  return expanded;
}

function escapeRegExp(char: string): string {
  return /[.+^$()|[\]\\{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:[^/]+/)*";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else {
      const char = glob.charAt(index);
      source += char === "*" ? "[^/]*" : char === "?" ? "[^/]" : escapeRegExp(char);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

/** A matcher for repo-relative POSIX paths supporting `**`, `*`, `?` and `{a,b}`. */
export function compileGlobs(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.flatMap(expandBraces).map(globToRegExp);
  return (path) => patterns.some((pattern) => pattern.test(path));
}
