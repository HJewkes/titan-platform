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
}

/**
 * Quote, substitution and heredoc state carried across the lines of one function body. It tracks only what can hold
 * verbatim text, not the full grammar: the guard's lexer rejects some zsh syntax that `typeset -f` prints. Where it
 * is unsure it sees a heredoc (zsh reads none from a one-line substitution): a body that runs long swallows a `}`
 * and header, which the parser flags, while one cut short would let verbatim text pose as a function.
 */
interface BodyScan {
  stack: Context[];
  pending: Heredoc[];
  reading: Heredoc[];
  broken: boolean;
  line: number;
  /** A `((` or `$((` at this index of the current line is read as code: it proved not to be arithmetic. */
  codeAt: number;
}

const HEREDOC_STARTERS: ReadonlySet<Kind> = new Set(["code", "cmdsub", "backtick"]);
const DELIMITER_END = new Set([" ", "\t", ";", "|", "&", "<", ">", "(", ")"]);
// `(` is left out so a zsh glob such as `(#b)(((a|b)))` opens no comment.
const WORD_START = new Set([" ", "\t", ";", "|", "&"]);
const COMMAND_KEYWORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "!", "{", "time"]);

export function newBodyScan(): BodyScan {
  return { stack: [{ kind: "code", depth: 0 }], pending: [], reading: [], broken: false, line: 0, codeAt: -1 };
}

/** True when the next line starts outside every quote, substitution and heredoc. */
export function atTopLevel(scan: BodyScan): boolean {
  return scan.stack.length === 1 && scan.pending.length === 0 && scan.reading.length === 0 && !scan.broken;
}

export function scanLine(scan: BodyScan, line: string): void {
  scan.line++;
  scan.codeAt = -1;
  const heredoc = scan.reading[0];
  if (heredoc) {
    if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) scan.reading.shift();
    return;
  }
  let i = 0;
  while (i < line.length) i = step(scan, line, i);
  const continued = i > line.length;
  if (!continued && HEREDOC_STARTERS.has(top(scan).kind)) scan.reading.push(...scan.pending.splice(0));
}

function top(scan: BodyScan): Context {
  return scan.stack.at(-1) ?? { kind: "code", depth: 0 };
}

function push(scan: BodyScan, kind: Kind, next: number): number {
  scan.stack.push({ kind, depth: 0 });
  return next;
}

function pop(scan: BodyScan, next: number): number {
  if (scan.stack.length > 1) scan.stack.pop();
  return next;
}

function step(scan: BodyScan, line: string, i: number): number {
  const kind = top(scan).kind;
  const c = line[i];
  if (kind === "sq") return c === "'" ? pop(scan, i + 1) : i + 1;
  if (c === "\\") return i + 2;
  if (kind === "dsq") return c === "'" ? pop(scan, i + 1) : i + 1;
  if (kind === "dq") return c === '"' ? pop(scan, i + 1) : (opener(scan, line, i) ?? i + 1);
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
  if (line[i] !== "`") return null;
  return top(scan).kind === "backtick" ? pop(scan, i + 1) : push(scan, "backtick", i + 1);
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
  if (line.startsWith("((", i) && i !== scan.codeAt && atCommandStart(line, i)) return pushArith(scan, i, i + 2);
  // `typeset -f` drops comments from code, but substitution text is printed verbatim, comments and all.
  if (wordStart && c === "#" && ctx.kind !== "code") return line.length;
  if (c === "(") ctx.depth++;
  else if (c === ")" && ctx.kind === "cmdsub" && ctx.depth === 0) return pop(scan, i + 1);
  else if (c === ")") ctx.depth = Math.max(0, ctx.depth - 1);
  else if (line.startsWith("<<<", i)) return i + 3;
  else if (line.startsWith("<<", i)) return heredocOperator(scan, line, i + 2);
  return i + 1;
}

function heredocOperator(scan: BodyScan, line: string, from: number): number {
  const stripTabs = line[from] === "-";
  let i = stripTabs ? from + 1 : from;
  while (line[i] === " " || line[i] === "\t") i++;
  const { word, end } = readDelimiter(line, i);
  if (word === null || word === "") scan.broken = true;
  else scan.pending.push({ delimiter: word, stripTabs });
  return end;
}

/** The delimiter with its quotes removed, as the heredoc's end line spells it; null when a quote is left open. */
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

/** `((` opens arithmetic only where a command starts; `[[ $x = ((#i)a)* ]]` is a zsh glob. */
function atCommandStart(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd();
  if (before === "" || /[;&|]$/.test(before)) return true;
  return COMMAND_KEYWORDS.has(before.split(/\s+/).at(-1) ?? "");
}
