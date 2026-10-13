import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** Builtins whose every operand is a variable name they write or unset. */
const OPERAND_WRITERS = new Set(["declare", "typeset", "local", "export", "readonly", "unset"]);
/** Option letters that take an argument, and which of those arguments is a name written. */
const OPTION_SPECS: Record<string, { takesArg: string; namesArg: string; operandsAreNames: boolean }> = {
  read: { takesArg: "adinNptu", namesArg: "a", operandsAreNames: true },
  mapfile: { takesArg: "dnOsuCc", namesArg: "", operandsAreNames: true },
  readarray: { takesArg: "dnOsuCc", namesArg: "", operandsAreNames: true },
  printf: { takesArg: "v", namesArg: "v", operandsAreNames: false },
};
/** Builtins that evaluate their arguments as shell or arithmetic text, so a run-time argument may assign any name. */
const EVALUATORS = new Set(["eval", "let"]);
/** Words that may precede the command word without being it. */
const COMMAND_PREFIXES = new Set(["{", "}", "!", "do", "then", "else", "elif", "if", "while", "until", "time", "done", "fi", "builtin", "command"]);
const NAME_BUILDER_RE = /[$`?*[]/;

/** A command segment and whether it sits inside `(( ))`, where any run-time word is arithmetic text. */
interface Segment {
  words: WordToken[];
  arith: boolean;
}

/**
 * Whether any command in the tokens may write a variable whose name only exists at run time: a write slot whose
 * name part holds an expansion, a command substitution or a glob, an evaluator given run-time text, or a run-time
 * command word that may be any of those builtins. The model answers true wherever it cannot read the name.
 */
export function mayWriteRunTimeName(tokens: readonly Token[]): boolean {
  return segments(tokens).some(segmentMayWrite);
}

function segments(tokens: readonly Token[]): Segment[] {
  const out: Segment[] = [];
  let words: WordToken[] = [];
  let arith = false;
  let afterOpen = false;
  for (const t of tokens) {
    if (t.type === "word") words.push(t);
    if (t.type !== "op") continue;
    out.push({ words, arith });
    words = [];
    if (t.value === ")") arith = false;
    else if (t.value === "(" && afterOpen) arith = true;
    afterOpen = t.value === "(";
  }
  out.push({ words, arith });
  return out;
}

function segmentMayWrite({ words, arith }: Segment): boolean {
  if (arith) return words.some(isRunTime);
  const at = words.findIndex((w) => !COMMAND_PREFIXES.has(w.value) && !ASSIGNMENT_RE.test(w.value) && !isOption(w));
  const command = words[at];
  if (!command) return false;
  const args = words.slice(at + 1);
  if (isRunTime(command)) return args.some(nameMayBeRunTime);
  if (EVALUATORS.has(command.value)) return args.some(isRunTime);
  return writeSlots(command.value, args).some(nameMayBeRunTime);
}

function writeSlots(command: string, args: WordToken[]): WordToken[] {
  if (OPERAND_WRITERS.has(command)) return scanOptions(args, "", "").operands;
  if (command === "for" || command === "select") return args.slice(0, 1);
  if (command === "getopts") return args.slice(1, 2);
  const spec = OPTION_SPECS[command];
  if (!spec) return [];
  const { slots, operands } = scanOptions(args, spec.takesArg, spec.namesArg);
  return spec.operandsAreNames ? [...slots, ...operands] : slots;
}

/** Bash reads options up to `--` or the first word that is none; a run-time option word may be any name. */
function scanOptions(args: WordToken[], takesArg: string, namesArg: string): { slots: WordToken[]; operands: WordToken[] } {
  const slots: WordToken[] = [];
  let i = 0;
  for (let w = args[i]; w; w = args[++i]) {
    if (isRunTime(w)) return { slots: [w], operands: args.slice(i) };
    if (w.value === "--") return { slots, operands: args.slice(i + 1) };
    if (!isOption(w)) break;
    const letter = [...w.value.slice(1)].findIndex((l) => takesArg.includes(l));
    if (letter < 0 || letter + 2 < w.value.length) continue;
    const arg = args[++i];
    if (arg && namesArg.includes(w.value[letter + 1] ?? "")) slots.push(arg);
  }
  return { slots, operands: args.slice(i) };
}

/**
 * The name part ends at a literal `NAME[` or `NAME=`; an expansion, a cut command substitution, a backquote or a
 * glob inside it lets bash build any name, IFS included. A literal name that spells IFS is matched elsewhere.
 */
function nameMayBeRunTime(w: WordToken): boolean {
  const literal = /^[A-Za-z_][A-Za-z0-9_]*/.exec(w.value)?.[0] ?? "";
  const eq = w.value.indexOf("=");
  const end = ASSIGNMENT_RE.test(w.value) ? literal.length : eq < 0 ? w.value.length : eq;
  return NAME_BUILDER_RE.test(w.value.slice(0, end)) || w.refs.some((r) => r.start < end) || (w.cuts ?? []).some((c) => c.at <= end);
}

function isRunTime(w: WordToken): boolean {
  return w.dynamic || w.computed;
}

function isOption(w: WordToken): boolean {
  return !isRunTime(w) && /^[-+]./s.test(w.value);
}
