const MAX_EXPANSIONS = 256;
const MAX_GLOB_LENGTH = 1024;
const MAX_BRACE_GROUPS = 32;
const INNERMOST_BRACE = /\{([^{}]*)\}/;

/** Every alternative of a brace glob, innermost group first; throws past 256 alternatives, 32 brace groups or 1024 characters. */
export function expandBraces(glob: string): string[] {
  assertBounded(glob);
  const out: string[] = [];
  collect(glob, out, glob);
  return out;
}

// Single-choice groups never grow the alternative count, so recursion depth and the copy of the
// glob each frame keeps are bounded by rejecting oversized globs before any expansion.
function assertBounded(glob: string): void {
  if (glob.length > MAX_GLOB_LENGTH) throw new Error(`glob is longer than ${MAX_GLOB_LENGTH} characters`);
  const groups = glob.split("{").length - 1;
  if (groups > MAX_BRACE_GROUPS) throw new Error(`glob has more than ${MAX_BRACE_GROUPS} brace groups`);
}

// The cap is checked as alternatives are produced, so a glob that expands past it stops
// after 257 strings instead of building the whole product first.
function collect(glob: string, out: string[], original: string): void {
  const match = INNERMOST_BRACE.exec(glob);
  if (!match) {
    out.push(glob);
    if (out.length > MAX_EXPANSIONS) throw tooMany(original);
    return;
  }
  const [group, body = ""] = match;
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + group.length);
  const choices = body.split(",");
  if (choices.length > MAX_EXPANSIONS) throw tooMany(original);
  for (const choice of choices) collect(head + choice + tail, out, original);
}

function tooMany(glob: string): Error {
  return new Error(`glob expands past ${MAX_EXPANSIONS} alternatives: ${glob.length > 80 ? `${glob.slice(0, 80)}...` : glob}`);
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
