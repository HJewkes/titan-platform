import type { Unwrapped } from "./unwrap.js";
import { commandWrites } from "./writers.js";

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
const NAMED_RE = new RegExp(`^(?:-[A-Za-z]+)?(${HOOKED_ALT})$`);

/** `${PS4:=x}`, `${PS4=x}` and zsh `${(A)module_path::=x}` assign while they expand. */
const DEFAULT_ASSIGN_RE = new RegExp(`\\$\\{(?:\\([^)]*\\))?(${HOOKED_ALT}):{0,2}=`);

/** `unset` and `let` name a parameter without giving it code to run later. */
const NOT_STORING = new Set(["let", "unset"]);

/**
 * The first hooked parameter the command writes, or null. Any value counts: bash decodes `\044` to `$` before it
 * expands PS4, so no check of the value can be sound.
 */
export function writesHookedParam(cmd: Unwrapped): string | null {
  return (
    assignedHooked(cmd) ??
    declaredHooked(cmd) ??
    commandWritesHooked(cmd) ??
    namedWriterHooked(cmd) ??
    expansionHooked(cmd)
  );
}

function assignedHooked(cmd: Unwrapped): string | null {
  return cmd.assigned.find(([name]) => HOOKED.has(name))?.[0] ?? null;
}

/** A declared name, or a nameref's target: `declare -n R=PS4` makes every later `R=` a PS4 write. */
function declaredHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !DECLARERS.has(name)) return null;
  for (const { value } of args) {
    const declared = DECLARED_RE.exec(value)?.[1];
    if (declared !== undefined && HOOKED.has(declared)) return declared;
    const target = value.slice(value.indexOf("=") + 1);
    if (value.includes("=") && HOOKED.has(target)) return target;
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

function expansionHooked({ args, assigned }: Unwrapped): string | null {
  return firstMatch([...args.map((a) => a.value), ...assigned.flatMap(([, value]) => value ?? [])], DEFAULT_ASSIGN_RE);
}

function firstMatch(texts: string[], re: RegExp): string | null {
  for (const text of texts) {
    const name = re.exec(text)?.[1];
    if (name !== undefined) return name;
  }
  return null;
}
