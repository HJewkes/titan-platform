import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { TARGET_RE, commandWrites } from "./writers.js";

/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
const HOOKED = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);
const HOOKED_ALT = [...HOOKED].join("|");

/** Kept local rather than exported from `vars.ts`, which other open tool-guard work edits. */
const DECLARED_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(?:\+?=|$)/s;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly", "private"]);

/** Commands whose option or operand names a parameter they set: `printf -v`, zsh `print -v`, `set -A`, `vared`. */
const NAMED_WRITERS = new Set([
  "printf", "print", "set", "vared", "zstyle", "zparseopts", "strftime", "zstat", "getln", "sysread", "zregexparse",
]);
const NAMED_RE = new RegExp(`^(?:-[A-Za-z]+)?(${HOOKED_ALT})(?:\\[.*\\])?$`, "s");

/** Every command whose arguments name a parameter it writes, so a brace in one may spell a hooked name. */
const NAME_WRITERS = new Set([...DECLARERS, ...NAMED_WRITERS, "read", "for", "select", "getopts", "mapfile", "readarray"]);

/** `${PS4:=x}`, `${PS4[0]=x}` and zsh `${(A)module_path::=x}` assign while they expand. */
const DEFAULT_ASSIGN_RE = new RegExp(`\\$\\{(?:\\([^)]*\\))?(${HOOKED_ALT})(?:\\[.*\\])?:{0,2}=`, "s");

/** `unset` and `let` name a parameter without giving it code to run later. */
const NOT_STORING = new Set(["let", "unset"]);

/** Past this many words a brace expansion is not read, and the command counts as a hooked write. */
const MAX_EXPANSIONS = 1024;
const SEQUENCE_RE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/;

/**
 * The first hooked parameter the command writes, or null. Any value counts: bash decodes `\044` to `$` before it
 * expands PS4, so no check of the value can be sound. `words` are the command's own words as written, prefix
 * assignments included: `Unwrapped.assigned` keeps no text for a dynamic value such as `X=${PS4:=x}`. A brace
 * expansion too large to read in a name-writing command returns the word itself.
 */
export function writesHookedParam(cmd: Unwrapped, words: WordToken[]): string | null {
  const named = cmd.name !== null && NAME_WRITERS.has(cmd.name) ? withBracesExpanded(cmd) : cmd;
  if (typeof named === "string") return named;
  return (
    assignedHooked(cmd) ??
    declaredHooked(named) ??
    commandWritesHooked(named) ??
    namedWriterHooked(named) ??
    expansionHooked([...words, ...cmd.args])
  );
}

function assignedHooked(cmd: Unwrapped): string | null {
  return cmd.assigned.find(([name]) => HOOKED.has(name))?.[0] ?? null;
}

/** A declared name, or a nameref's target: `declare -n R=PS4[0]` makes every later `R=` a PS4 write. */
function declaredHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !DECLARERS.has(name)) return null;
  for (const { value } of args) {
    const declared = DECLARED_RE.exec(value)?.[1];
    if (declared !== undefined && HOOKED.has(declared)) return declared;
    const target = value.includes("=") ? TARGET_RE.exec(value.slice(value.indexOf("=") + 1))?.[1] : undefined;
    if (target !== undefined && HOOKED.has(target)) return target;
  }
  return null;
}

function commandWritesHooked({ name, args }: Unwrapped): string | null {
  if (name === null || NOT_STORING.has(name)) return null;
  return commandWrites(name, args, new Map())?.find(([written]) => HOOKED.has(written))?.[0] ?? null;
}

function namedWriterHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !NAMED_WRITERS.has(name)) return null;
  return firstMatch(args.map((a) => a.value), NAMED_RE);
}

/** Only a dynamic word expands: a quoted `'${PS4:=x}'` in a commit message is text. */
function expansionHooked(words: WordToken[]): string | null {
  return firstMatch(words.filter((w) => w.dynamic).map((w) => w.value), DEFAULT_ASSIGN_RE);
}

function firstMatch(texts: string[], re: RegExp): string | null {
  for (const text of texts) {
    const name = re.exec(text)?.[1];
    if (name !== undefined) return name;
  }
  return null;
}

/** The command with each argument brace-expanded, as bash does: `export {P,}S4=x` exports `PS4=x S4=x`. */
function withBracesExpanded(cmd: Unwrapped): Unwrapped | string {
  const args: WordToken[] = [];
  for (const arg of cmd.args) {
    const values = braceExpand(arg.value);
    if (values === null) return arg.value;
    args.push(...values.map((value) => ({ ...arg, value })));
  }
  return { ...cmd, args };
}

/** The words a brace expansion makes, or null past `MAX_EXPANSIONS`. A quoted brace is expanded too, which only over-reads. */
function braceExpand(text: string): string[] | null {
  const group = firstGroup(text);
  if (group === null) return [text];
  const out: string[] = [];
  for (const part of group.parts) {
    const expanded = braceExpand(text.slice(0, group.start) + part + text.slice(group.end + 1));
    if (expanded === null || out.push(...expanded) > MAX_EXPANSIONS) return null;
  }
  return out;
}

/** The first `{a,b}` or `{x..y}` outside a `${ }`, with its alternatives; a brace with neither is literal. */
function firstGroup(text: string): { start: number; end: number; parts: string[] } | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    if (end < 0) return null;
    if (text[start - 1] === "$") {
      start = end;
      continue;
    }
    const parts = alternatives(text.slice(start + 1, end));
    if (parts !== null) return { start, end, parts };
  }
  return null;
}

function closingBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The comma-separated parts at the top level of a brace body, or a sequence's members. */
function alternatives(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    if (body[i] === "}") depth--;
    if (body[i] === "," && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  if (parts.length > 0) return [...parts, body.slice(from)];
  const sequence = SEQUENCE_RE.exec(body);
  return sequence ? sequenceMembers(sequence[1] as string, sequence[2] as string, Number(sequence[3] ?? 1)) : null;
}

/** `{1..9}` or `{a..z}`; a sequence longer than `MAX_EXPANSIONS` returns one word past the bound, which fails the read. */
function sequenceMembers(from: string, to: string, step: number): string[] {
  const numeric = /\d/.test(from) && /\d/.test(to);
  const [a, b] = numeric ? [Number(from), Number(to)] : [from.charCodeAt(0), to.charCodeAt(0)];
  const stride = Math.max(1, Math.abs(step)) * (a <= b ? 1 : -1);
  const out: string[] = [];
  for (let n = a; a <= b ? n <= b : n >= b; n += stride) {
    out.push(numeric ? String(n) : String.fromCharCode(n));
    if (out.length > MAX_EXPANSIONS) break;
  }
  return out;
}
