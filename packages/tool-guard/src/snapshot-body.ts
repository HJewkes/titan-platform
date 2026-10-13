type Kind = "code" | "cmdsub" | "backtick" | "arith" | "param" | "dq" | "sq" | "dsq";

interface Context {
  kind: Kind;
  depth: number;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

/**
 * Quote, substitution and heredoc state carried across the lines of one function body. It tracks only what can hold
 * verbatim text, not the full grammar: the guard's lexer rejects some zsh syntax that `typeset -f` prints.
 */
interface BodyScan {
  stack: Context[];
  pending: Heredoc[];
  reading: Heredoc[];
  broken: boolean;
}

const HEREDOC_STARTERS: ReadonlySet<Kind> = new Set(["code", "cmdsub", "backtick"]);
const DELIMITER_END = new Set([" ", "\t", ";", "|", "&", "<", ">", "(", ")"]);

export function newBodyScan(): BodyScan {
  return { stack: [{ kind: "code", depth: 0 }], pending: [], reading: [], broken: false };
}

/** True when the next line starts outside every quote, substitution and heredoc. */
export function atTopLevel(scan: BodyScan): boolean {
  return scan.stack.length === 1 && scan.pending.length === 0 && scan.reading.length === 0 && !scan.broken;
}

export function scanLine(scan: BodyScan, line: string): void {
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
  if (line.startsWith("$((", i)) return push(scan, "arith", i + 3);
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

function arithStep(scan: BodyScan, line: string, i: number): number {
  const ctx = top(scan);
  if (line[i] === "(") ctx.depth++;
  else if (line[i] === ")" && ctx.depth > 0) ctx.depth--;
  else if (line.startsWith("))", i)) return pop(scan, i + 2);
  return i + 1;
}

function codeStep(scan: BodyScan, line: string, i: number): number {
  const ctx = top(scan);
  const c = line[i];
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
