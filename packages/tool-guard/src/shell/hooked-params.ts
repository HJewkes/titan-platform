import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { TARGET_RE } from "./writers.js";

/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
const HOOKED = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);
const HOOKED_ALT = [...HOOKED].join("|");

const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly", "private"]);

/** Commands whose every argument but a literal option may name a parameter they write. */
const ALL_ARG_WRITERS = new Set([
  ...DECLARERS, "read", "mapfile", "readarray", "vared", "zstyle", "zparseopts", "strftime", "zstat", "getln", "sysread",
  "zregexparse",
]);

/** `${PS4:=x}`, `${PS4[0]=x}` and zsh `${(A)module_path::=x}` assign while they expand. */
const DEFAULT_ASSIGN_RE = new RegExp(`\\$\\{(?:\\([^)]*\\))?(${HOOKED_ALT})(?:\\[.*\\])?:{0,2}=`, "s");

const OPTION_RE = /^[-+][A-Za-z]*$/;
const IDENTIFIER_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
/** The only unquoted name a slot may hold: an identifier with an optional literal subscript. */
const PLAIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]*\])?$/;
/** Characters that expand, glob or brace-expand outside quotes, in bash or zsh. */
const EXPANDING_RE = /[$`*?[\]{}~^#]/;
const SUBSCRIPTED_RE = /^([A-Za-z_][A-Za-z0-9_]*)\[([A-Za-z0-9_]*)\]$/;

/**
 * The first hooked parameter the command writes, or null. Any value counts: bash decodes `\044` to `$` before it
 * expands PS4, so no check of the value can be sound. `words` are the command's own words as written, prefix
 * assignments included: `Unwrapped.assigned` keeps no text for a dynamic value such as `X=${PS4:=x}`. A name
 * slot whose name the shell computes (expanded, globbed, braced) returns the slot's text.
 */
export function writesHookedParam(cmd: Unwrapped, words: WordToken[]): string | null {
  return (
    assignedHooked(cmd) ??
    slotsHooked(cmd) ??
    namerefHooked(cmd) ??
    expansionHooked([...words, ...cmd.args])
  );
}

function assignedHooked(cmd: Unwrapped): string | null {
  return cmd.assigned.find(([name]) => HOOKED.has(name))?.[0] ?? null;
}

function slotsHooked(cmd: Unwrapped): string | null {
  for (const slot of nameSlots(cmd)) {
    const hooked = slotHooked(slot);
    if (hooked !== null) return hooked;
  }
  return null;
}

/** The words a command reads as names it writes; a dynamic word where an option may sit counts as one. */
function nameSlots({ name, args }: Unwrapped): WordToken[] {
  if (name === null) return [];
  if (name === "printf" || name === "print") return optionOperands(args, /^-[A-Za-z]*?v/);
  if (name === "set") return optionOperands(args, /^[-+][A-Za-z]*?A/);
  if (name === "for" || name === "select") return args.slice(0, 1);
  if (name === "getopts") return args.slice(1, 2);
  if (ALL_ARG_WRITERS.has(name)) return args.filter((a) => a.dynamic || !OPTION_RE.test(a.value));
  return [];
}

/** The name an option takes, attached (`-vNAME`) or next (`-v NAME`), up to the first operand or `--`. */
function optionOperands(args: WordToken[], option: RegExp): WordToken[] {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as WordToken;
    if (word.dynamic) return [word];
    const taken = option.exec(word.value);
    if (!taken) {
      if (word.value === "--" || !OPTION_RE.test(word.value)) return [];
      continue;
    }
    const attached = word.value.slice(taken[0].length);
    const next = args[i + 1];
    if (attached) return [{ ...word, value: attached }];
    return next ? [next] : [];
  }
  return [];
}

/**
 * A slot passes when it is literal and names no hooked parameter: an identifier with an optional literal
 * subscript, or any other literal text, which the shell rejects as a name without writing.
 */
function slotHooked(slot: WordToken): string | null {
  const name = namePart(slot);
  if (name === null) return slot.value;
  const quoted = slot.quoted && !slot.spliced;
  if (!quoted && !PLAIN_NAME_RE.test(name) && EXPANDING_RE.test(name)) return slot.value;
  const identifier = IDENTIFIER_PREFIX_RE.exec(name)?.[0];
  if (identifier !== undefined && HOOKED.has(identifier)) return identifier;
  return !quoted && subscriptGlobsHooked(name) ? slot.value : null;
}

/** The text before the first `=` (and a `+=`'s `+`), or null when an expansion sits there. */
function namePart(slot: WordToken): string | null {
  const eq = slot.value.indexOf("=");
  const end = eq < 0 ? slot.value.length : eq;
  const name = slot.value.slice(0, end);
  if (slot.dynamic && (/[$`]/.test(name) || slot.cuts?.some((cut) => cut.at <= end))) return null;
  return name.replace(/\+$/, "");
}

/** An unquoted `PS[4]` is a bracket expression too, and globs to PS4 once a file of that name exists. */
function subscriptGlobsHooked(name: string): boolean {
  const [, base, chars] = SUBSCRIPTED_RE.exec(name) ?? [];
  return base !== undefined && [...(chars ?? "")].some((ch) => HOOKED.has(base + ch));
}

/** `declare -n R=PS4[0]` makes every later `R=` a PS4 write. */
function namerefHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !DECLARERS.has(name)) return null;
  for (const { value } of args) {
    const target = value.includes("=") ? TARGET_RE.exec(value.slice(value.indexOf("=") + 1))?.[1] : undefined;
    if (target !== undefined && HOOKED.has(target)) return target;
  }
  return null;
}

/** Only a dynamic word expands: a quoted `'${PS4:=x}'` in a commit message is text. */
function expansionHooked(words: WordToken[]): string | null {
  for (const word of words) {
    const name = word.dynamic ? DEFAULT_ASSIGN_RE.exec(word.value)?.[1] : undefined;
    if (name !== undefined) return name;
  }
  return null;
}
