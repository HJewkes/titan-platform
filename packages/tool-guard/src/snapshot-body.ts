type Kind = "code" | "cmdsub" | "backtick" | "arith" | "param" | "dq" | "sq" | "dsq";

interface Context {
  kind: Kind;
  depth: number;
  /** Where an arithmetic context's `((` or `$((` stands, so it can be read again as code. */
  origin?: { line: number; at: number };
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  /** Stack index of the code or `$( )` context the operator stands in; zsh reads its body inside that text only. */
  owner: number;
}

/**
 * Quote, substitution and heredoc state carried across the lines of one function body. It tracks only what can hold
 * verbatim text, not the full grammar: the guard's lexer rejects some zsh syntax that `typeset -f` prints. Wherever
 * its reading could part from zsh's, it sets `broken` instead of guessing, because a guess in either direction can
 * end a body early and let verbatim text pose as a function.
 */
interface BodyScan {
  stack: Context[];
  pending: Heredoc[];
  reading: Heredoc[];
  broken: boolean;
  line: number;
  /** A `((` or `$((` at this index of the current line is read as code: it proved not to be arithmetic. */
  codeAt: number;
  /** A `((` on the current line was read as code; zsh may have read it as arithmetic, where `<<` is a shift. */
  parensAsCode: boolean;
}

const HEREDOC_STARTERS: ReadonlySet<Kind> = new Set(["code", "cmdsub"]);
const PROCESS_SUBSTITUTIONS = ["<(", ">("];
// Backticks end at the first unescaped backtick whatever quotes they hold; only plain text inside them is followed.
const BACKTICK_UNSURE = /^(?:['"]|\$[({[]|<<|\\`)/;
// zsh lexes arithmetic text with these (and `$'`) as literals, not quotes, so one could open a quote zsh never sees.
const ARITH_UNSURE = new Set(["'", '"', "`"]);
const DELIMITER_END = new Set([" ", "\t", ";", "|", "&", "<", ">", "(", ")"]);
// Only plain ' " \ quoting is removed the way zsh removes it; `$'EOF'`, `$X` or a backtick could spell another end line.
const PLAIN_DELIMITER = /^[A-Za-z0-9_.-]+$/;
// `(` is left out so a zsh glob such as `(#b)(((a|b)))` opens no comment.
const WORD_START = new Set([" ", "\t", ";", "|", "&"]);
const COMMAND_KEYWORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "!", "{", "time"]);

export function newBodyScan(): BodyScan {
  return { stack: [{ kind: "code", depth: 0 }], pending: [], reading: [], broken: false, line: 0, codeAt: -1, parensAsCode: false };
}

/** True when the next line starts outside every quote, substitution and heredoc. */
export function atTopLevel(scan: BodyScan): boolean {
  return scan.stack.length === 1 && scan.pending.length === 0 && scan.reading.length === 0 && !scan.broken;
}

export function scanLine(scan: BodyScan, line: string): void {
  scan.line++;
  scan.codeAt = -1;
  scan.parensAsCode = false;
  const heredoc = scan.reading[0];
  if (heredoc) {
    if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) scan.reading.shift();
    return;
  }
  let i = 0;
  while (i < line.length) i = step(scan, line, i);
  const continued = i > line.length;
  if (continued || !HEREDOC_STARTERS.has(top(scan).kind) || scan.pending.length === 0) return;
  // A newline inside a later `$( )` does not start a body opened outside it.
  if (scan.pending.some((h) => h.owner !== scan.stack.length - 1)) scan.broken = true;
  scan.reading.push(...scan.pending.splice(0));
}

function top(scan: BodyScan): Context {
  return scan.stack.at(-1) ?? { kind: "code", depth: 0 };
}

function push(scan: BodyScan, kind: Kind, next: number): number {
  scan.stack.push({ kind, depth: 0 });
  return next;
}

/** Closing a `$( )` on the line of a heredoc it holds leaves zsh no body to read, where bash reads one. */
function pop(scan: BodyScan, next: number): number {
  if (scan.stack.length <= 1) return next;
  const closed = scan.stack.length - 1;
  if (scan.pending.some((h) => h.owner >= closed)) scan.broken = true;
  scan.stack.pop();
  return next;
}

function step(scan: BodyScan, line: string, i: number): number {
  const kind = top(scan).kind;
  const c = line[i];
  if (kind === "sq") return c === "'" ? pop(scan, i + 1) : i + 1;
  if (kind === "backtick") return backtickStep(scan, line, i);
  if (c === "\\") return i + 2;
  if (kind === "dsq") return c === "'" ? pop(scan, i + 1) : i + 1;
  if (kind === "dq") return c === '"' ? pop(scan, i + 1) : (opener(scan, line, i) ?? i + 1);
  if (kind === "arith" && (ARITH_UNSURE.has(c ?? "") || line.startsWith("$'", i))) {
    scan.broken = true;
    return i + 1;
  }
  const opened = quoteOpener(scan, line, i) ?? opener(scan, line, i);
  if (opened !== null) return opened;
  if (kind === "param") return paramStep(scan, c, i);
  if (kind === "arith") return arithStep(scan, line, i);
  return codeStep(scan, line, i);
}

function quoteOpener(scan: BodyScan, line: string, i: number): number | null {
  if (line[i] === "'") return push(scan, "sq", i + 1);
  if (line[i] === '"') return push(scan, "dq", i + 1);
  if (line.startsWith("$'", i)) return push(scan, "dsq", i + 2);
  return null;
}

function opener(scan: BodyScan, line: string, i: number): number | null {
  if (line.startsWith("$((", i) && i !== scan.codeAt) return pushArith(scan, i, i + 3);
  if (line.startsWith("$(", i)) return push(scan, "cmdsub", i + 2);
  if (line.startsWith("${", i)) return push(scan, "param", i + 2);
  if (line.startsWith("$[", i)) scan.broken = true;
  return line[i] === "`" ? push(scan, "backtick", i + 1) : null;
}

function backtickStep(scan: BodyScan, line: string, i: number): number {
  if (line[i] === "`") return pop(scan, i + 1);
  if (BACKTICK_UNSURE.test(line.slice(i, i + 2))) scan.broken = true;
  return line[i] === "\\" ? i + 2 : i + 1;
}

function paramStep(scan: BodyScan, c: string | undefined, i: number): number {
  const ctx = top(scan);
  if (c === "{") ctx.depth++;
  else if (c === "}") return ctx.depth === 0 ? pop(scan, i + 1) : (ctx.depth--, i + 1);
  return i + 1;
}

function pushArith(scan: BodyScan, at: number, next: number): number {
  scan.stack.push({ kind: "arith", depth: 0, origin: { line: scan.line, at } });
  return next;
}

function arithStep(scan: BodyScan, line: string, i: number): number {
  const ctx = top(scan);
  if (line[i] === "(") ctx.depth++;
  else if (line[i] === ")" && ctx.depth > 0) ctx.depth--;
  else if (line[i] === ")") return line[i + 1] === ")" ? pop(scan, i + 2) : notArithmetic(scan, ctx, i);
  return i + 1;
}

/**
 * A lone `)` at depth 0 means the `((` was nested subshells or a zsh case pattern such as `((a|)b)`, as zsh's
 * cmd_or_math decides. The line is read again from the `((` as code, so a heredoc inside it is seen; when the `((`
 * stood on an earlier line, that cannot be redone and the scan is broken.
 */
function notArithmetic(scan: BodyScan, ctx: Context, i: number): number {
  pop(scan, i);
  if (ctx.origin?.line !== scan.line) {
    scan.broken = true;
    return i + 1;
  }
  scan.codeAt = ctx.origin.at;
  return ctx.origin.at;
}

function codeStep(scan: BodyScan, line: string, i: number): number {
  const ctx = top(scan);
  const c = line[i];
  const wordStart = i === 0 || WORD_START.has(line[i - 1] ?? "");
  if (line.startsWith("((", i)) {
    if (i !== scan.codeAt && atCommandStart(line, i)) return pushArith(scan, i, i + 2);
    scan.parensAsCode = true;
  }
  if (ctx.kind === "cmdsub") substitutionText(scan, line, i, wordStart);
  if (wordStart && c === "#" && ctx.kind === "cmdsub") return line.length;
  if (PROCESS_SUBSTITUTIONS.some((op) => line.startsWith(op, i)) || (wordStart && line.startsWith("=(", i))) {
    return push(scan, "cmdsub", i + 2);
  }
  if (c === "(") ctx.depth++;
  else if (c === ")" && ctx.kind === "cmdsub" && ctx.depth === 0) return pop(scan, i + 1);
  else if (c === ")") ctx.depth = Math.max(0, ctx.depth - 1);
  else if (line.startsWith("<<<", i)) return i + 3;
  else if (line.startsWith("<<", i)) return heredocOperator(scan, line, i + 2);
  return i + 1;
}

/**
 * `typeset -f` drops comments from code but prints `$( )` text verbatim. There a bare case pattern's `)` would end
 * the substitution early, and `(#` may be a glob flag or a comment, so neither is followed.
 */
function substitutionText(scan: BodyScan, line: string, i: number, wordStart: boolean): void {
  const commandWord = wordStart || line[i - 1] === "(";
  if (commandWord && /^case(?:\s|$)/.test(line.slice(i, i + 5))) scan.broken = true;
  if (line.startsWith("(#", i)) scan.broken = true;
}

function heredocOperator(scan: BodyScan, line: string, from: number): number {
  const stripTabs = line[from] === "-";
  let i = stripTabs ? from + 1 : from;
  while (line[i] === " " || line[i] === "\t") i++;
  const { word, end } = readDelimiter(line, i);
  if (word === null || !PLAIN_DELIMITER.test(word) || scan.parensAsCode) scan.broken = true;
  else scan.pending.push({ delimiter: word, stripTabs, owner: scan.stack.length - 1 });
  return end;
}

/** The delimiter with plain ' " \ quotes removed; null when a quote is left open. Any other char is kept as is. */
function readDelimiter(line: string, from: number): { word: string | null; end: number } {
  let word = "";
  let i = from;
  while (i < line.length && !DELIMITER_END.has(line[i] ?? "")) {
    const c = line[i] ?? "";
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      if (close === -1) return { word: null, end: line.length };
      word += line.slice(i + 1, close);
      i = close + 1;
    } else if (c === "\\") {
      word += line[i + 1] ?? "";
      i += 2;
    } else {
      word += c;
      i++;
    }
  }
  return { word, end: i };
}

/**
 * `((` opens arithmetic only where a command starts; `[[ $x = ((#i)a)* ]]` is a zsh glob. A `)` before it ends a
 * case arm's pattern. Positions this misses are caught by `parensAsCode`.
 */
function atCommandStart(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd();
  if (before === "" || /[;&|)]$/.test(before)) return true;
  return COMMAND_KEYWORDS.has(before.split(/\s+/).at(-1) ?? "");
}
