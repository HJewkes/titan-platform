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

/** A range bash expands to integers; any other `..` may make letters, so it is not read. */
const INTEGER_RANGE_RE = /\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\}/g;

/**
 * The first hooked parameter the command writes, or null. Any value counts: bash decodes `\044` to `$` before it
 * expands PS4, so no check of the value can be sound. `words` are the command's own words as written, prefix
 * assignments included: `Unwrapped.assigned` keeps no text for a dynamic value such as `X=${PS4:=x}`. A brace
 * word that may spell a hooked name in a name-writing command returns the word itself.
 */
export function writesHookedParam(cmd: Unwrapped, words: WordToken[]): string | null {
  return (
    assignedHooked(cmd) ??
    braceHooked(cmd) ??
    declaredHooked(cmd) ??
    commandWritesHooked(cmd) ??
    namedWriterHooked(cmd) ??
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

function braceHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !NAME_WRITERS.has(name)) return null;
  return args.find((a) => a.value.includes("{") && braceMaySpellHooked(a.value))?.value ?? null;
}

/**
 * A brace list only drops characters, so without a range a word can spell a hooked name only if it holds the
 * name's characters in order. This reads the quote-removed value, where a quoted or escaped brace looks
 * unquoted, so it errs toward a write instead of parsing which braces bash expands, and it never expands.
 */
function braceMaySpellHooked(value: string): boolean {
  const rest = value.replace(INTEGER_RANGE_RE, "");
  if (rest.includes("..")) return true;
  const digitsMayCome = rest.length < value.length;
  return [...HOOKED].some((hooked) => holdsInOrder(value, digitsMayCome ? hooked.replace(/\d/g, "") : hooked));
}

/** A linear scan; a regex such as `P.*S.*4` backtracks on a long word that lacks the last character. */
function holdsInOrder(text: string, wanted: string): boolean {
  let at = 0;
  for (const ch of text) if (ch === wanted[at] && ++at === wanted.length) return true;
  return false;
}
