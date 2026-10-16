import type { CaseFrame, RegexScan, Token } from "./tokens.js";

/** Words that open or close a block in command position; an `esac` or `;;` inside one is a bash syntax error. */
const BLOCK_OPENERS = new Set(["{", "if", "for", "while", "until", "select"]);
const BLOCK_CLOSERS = new Set(["}", "fi", "done"]);

/**
 * Tracks each open `case` by bash's grammar position, since only position makes `case` or `esac` a keyword and a `)` a
 * pattern end: `(esac)` is a pattern, and a `case` that opens a pattern body nests. Anything bash would not accept
 * leaves the frame stuck, never closed, so a substitution holding it never ends and the guard refuses it.
 */
export function openCase(r: RegexScan): void {
  r.cases.push({ phase: "subject", depth: r.depth, amp: false, blocks: 0 });
}

/** An `esac` in command position closes a body at its own paren depth; any other is a bash syntax error. */
export function closeCase(r: RegexScan): void {
  const top = r.cases[r.cases.length - 1];
  if (!top) r.cases.push({ phase: "stuck", depth: r.depth, amp: false, blocks: 0 });
  else if (top.phase === "body" && top.depth === r.depth && top.blocks === 0) r.cases.pop();
  else top.phase = "stuck";
}

/** Counts the blocks a word in command position opens or closes inside the innermost case body. */
export function noteCaseBlock(r: RegexScan, bare: string): void {
  const top = r.cases[r.cases.length - 1];
  if (top?.phase !== "body") return;
  if (BLOCK_OPENERS.has(bare)) top.blocks++;
  if (BLOCK_CLOSERS.has(bare) && top.blocks-- === 0) top.phase = "stuck";
}

/** Reads a word in a `case` header or pattern list, where no word is a command; false once a body has begun. */
export function caseWord(r: RegexScan, t: Token, bare: string | null): boolean {
  const top = r.cases[r.cases.length - 1];
  if (!top || top.phase === "body" || top.phase === "stuck") {
    if (top) top.amp = false;
    return false;
  }
  if (top.phase === "patterns" && bare === "esac") r.cases.pop();
  else top.phase = nextAfterWord(top.phase, t, bare);
  return true;
}

function nextAfterWord(phase: CaseFrame["phase"], t: Token, bare: string | null): CaseFrame["phase"] {
  if (t.type !== "word") return "stuck";
  if (phase === "subject") return "in";
  if (phase === "in") return bare === "in" ? "patterns" : "stuck";
  return phase === "patterns" || phase === "alternative" ? "pattern" : "stuck";
}

/** Whether the paren `op` opens or ends a case pattern, or would underflow a body, and so leaves the depth alone. */
export function isCaseParen(r: RegexScan, op: string): boolean {
  const top = r.cases[r.cases.length - 1];
  if (!top) return false;
  if (op === "(") return top.phase === "patterns";
  return op === ")" && top.depth === r.depth && top.phase !== "subject" && top.phase !== "in";
}

/** Moves the innermost case past the operator `op`, before `r.depth` moves for it. */
export function caseOperator(r: RegexScan, op: string): void {
  const top = r.cases[r.cases.length - 1];
  if (!top || top.phase === "stuck") return;
  const amp = top.amp;
  top.amp = false;
  if (top.phase === "body") bodyOperator(top, op, r.depth, amp);
  else top.phase = nextAfterOperator(top.phase, op, amp);
}

function nextAfterOperator(phase: CaseFrame["phase"], op: string, amp: boolean): CaseFrame["phase"] {
  if (phase === "pattern") return op === "|" ? "alternative" : op === ")" ? "body" : "stuck";
  if (phase === "patterns" && op === "(") return "alternative";
  const stays = (phase === "in" || phase === "patterns") && (op === "\n" || (phase === "patterns" && op === "&" && amp));
  return stays ? phase : "stuck";
}

/** `;;`, and `;&` or `;;&` which bash lexes here as `;` or `;;` then `&`, return a body to its pattern list. */
function bodyOperator(top: CaseFrame, op: string, depth: number, amp: boolean): void {
  if (depth !== top.depth) return;
  if (top.blocks !== 0 && (op === ";;" || op === ")")) top.phase = "stuck";
  else if (op === ";;") Object.assign(top, { phase: "patterns", amp: true });
  else if (op === ";") top.amp = true;
  else if (op === "&" && amp) top.phase = "patterns";
  else if (op === ")") top.phase = "stuck";
}
