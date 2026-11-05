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

// `segments` is `**/`: zero or more whole `name/` segments. `any` is a bare `**`.
type Token =
  | { readonly kind: "literal"; readonly char: string }
  | { readonly kind: "one" | "star" | "any" | "segments" };

function tokenize(glob: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      tokens.push({ kind: "segments" });
      index += 3;
    } else if (glob.startsWith("**", index)) {
      tokens.push({ kind: "any" });
      index += 2;
    } else {
      const char = glob.charAt(index);
      tokens.push(char === "*" ? { kind: "star" } : char === "?" ? { kind: "one" } : { kind: "literal", char });
      index += 1;
    }
  }
  return tokens;
}

// A backtracking RegExp goes polynomial or exponential on runs like `*a*a*a` or `**/**/**/`, so
// one allow line could hang a scan. Simulating the glob as a set of NFA states instead costs
// path length times glob length on every input. State 2i is "at token i"; 2i+1 is "inside a
// segment of the `**/` at token i", which must reach its `/` before the token can end.
function addState(tokens: readonly Token[], states: Uint8Array, state: number): void {
  if (states[state] === 1) return;
  states[state] = 1;
  const token = tokens[state >> 1];
  if (state % 2 === 0 && token && token.kind !== "literal" && token.kind !== "one") {
    addState(tokens, states, state + 2);
  }
}

function step(tokens: readonly Token[], from: Uint8Array, char: string): Uint8Array {
  const next = new Uint8Array(from.length);
  const inSegment = char !== "/";
  from.forEach((on, state) => {
    const token = on === 1 ? tokens[state >> 1] : undefined;
    if (!token) return;
    const at = state & ~1;
    if (token.kind === "literal" && token.char === char) addState(tokens, next, at + 2);
    else if (token.kind === "one" && inSegment) addState(tokens, next, at + 2);
    else if (token.kind === "any" || (token.kind === "star" && inSegment)) addState(tokens, next, at);
    else if (token.kind === "segments" && inSegment) addState(tokens, next, at + 1);
    else if (token.kind === "segments" && state !== at) addState(tokens, next, at);
  });
  return next;
}

function globMatcher(glob: string): (path: string) => boolean {
  const tokens = tokenize(glob);
  const accept = tokens.length * 2;
  return (path) => {
    let states: Uint8Array = new Uint8Array(accept + 2);
    addState(tokens, states, 0);
    // UTF-16 code units, as the RegExp this replaced matched without the `u` flag.
    for (let index = 0; index < path.length; index += 1) states = step(tokens, states, path.charAt(index));
    return states[accept] === 1;
  };
}

/** A matcher for repo-relative POSIX paths supporting `**`, `*`, `?` and `{a,b}`, in time linear in the path. */
export function compileGlobs(globs: readonly string[]): (path: string) => boolean {
  const matchers = globs.flatMap(expandBraces).map(globMatcher);
  return (path) => matchers.some((matches) => matches(path));
}
