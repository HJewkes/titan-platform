import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { ReadingLimitError } from "./unsure-readings.js";

/** zsh's alias tables as parameters, and bash's: a store into any of them defines an alias without the `alias` builtin. */
const ALIAS_PARAMS = new Set(["aliases", "galiases", "saliases", "dis_aliases", "dis_galiases", "dis_saliases", "BASH_ALIASES"]);
const PARAM = String.raw`(?:(?:dis_)?[gs]?aliases|BASH_ALIASES)`;
/** A word naming an alias parameter as a store's target, alone or attached to an option cluster: `aliases[y]`, `-valiases[y]`. */
const STORED_PARAM_RE = new RegExp(String.raw`^(?:[-+][A-Za-z]*)?${PARAM}(?:\[|\+?=|$)`);
/** An alias parameter inside a `${ }` expansion, which the lexer leaves without refs. */
const EXPANDED_PARAM_RE = new RegExp(String.raw`\$\{[^}]*?(?<![A-Za-z0-9_])${PARAM}(?![A-Za-z0-9_])`);
/** An assigning expansion of a name read through `(P)`, which may name an alias parameter: `${(P)n::=git}`. */
const INDIRECT_STORE_RE = /\$\{\([^)]*P[^)]*\)[^}]*?:{0,2}=/;
/** Builtins that store into a parameter their arguments name. */
const STORE_BUILTINS = new Set([
  "typeset", "declare", "local", "export", "readonly", "integer", "float", "set",
  "read", "print", "printf", "zparseopts", "vared", "getopts", "unset", "zstyle", "zformat", "strftime",
]);
/** Options `alias` itself takes, so a dynamic command word that may be `alias` is read past them. */
const ALIAS_OPTION_RE = /^[-+][gsrLm]+$/;
const DEFINITION_RE = /^[^=/\s]+=/;

/**
 * A line that defines a shell alias; the hook denies it unchecked. Eval text, `$( )` and sourced files that zsh parses
 * later in the same process expand the alias, and the guard does not model the alias table.
 */
export class AliasDefinitionError extends ReadingLimitError {
  constructor() {
    super();
    this.message = "a command that defines a shell alias";
    this.name = "AliasDefinitionError";
  }
}

/** Whether the command defines or may define an alias that text the shell parses later in the same process would expand. */
export function definesAlias(cmd: Unwrapped): boolean {
  return (
    (cmd.name === "alias" && splitOptions(cmd.args).operands.some((w) => w.dynamic || w.value.includes("=")))
    || (cmd.name === "enable" && enablesAliases(cmd.args))
    || cmd.assigned.some(([name]) => ALIAS_PARAMS.has(name))
    || cmd.args.some(expandsAliasParam)
    || (cmd.name !== null && STORE_BUILTINS.has(cmd.name) && cmd.args.some((w) => STORED_PARAM_RE.test(w.value)))
    || (cmd.name === null && dynamicDefinition(cmd.args.slice(1)))
  );
}

/**
 * Options and operands as zsh's builtins read them: options run up to `--`, a lone `-` (both dropped), or the first
 * operand, and every word after that is an operand. A dynamic word may expand to an operand, so it starts them.
 */
function splitOptions(args: WordToken[]): { options: WordToken[]; operands: WordToken[] } {
  const at = args.findIndex((w) => w.dynamic || !/^[-+]./.test(w.value) || w.value === "--");
  if (at === -1) return { options: args, operands: [] };
  const end = args[at] as WordToken;
  const dropped = !end.dynamic && (end.value === "--" || end.value === "-");
  return { options: args.slice(0, at), operands: args.slice(dropped ? at + 1 : at) };
}

/** `enable -a` turns disabled aliases back on; a dynamic word where options may still stand may be `-a`. */
function enablesAliases(args: WordToken[]): boolean {
  const { options, operands } = splitOptions(args);
  return operands[0]?.dynamic === true || options.some((w) => w.value.startsWith("-") && w.value.includes("a"));
}

function expandsAliasParam(w: WordToken): boolean {
  if (w.refs.some((ref) => ALIAS_PARAMS.has(ref.name))) return true;
  return w.dynamic && (EXPANDED_PARAM_RE.test(w.value) || INDIRECT_STORE_RE.test(w.value));
}

/**
 * A dynamic command word may be `alias`, so a `NAME=VALUE` operand may define one. An option `alias` does not take
 * means the command is something else, as in `"$PY" -c x=1`.
 */
function dynamicDefinition(args: WordToken[]): boolean {
  const { options, operands } = splitOptions(args);
  if (!options.every((w) => ALIAS_OPTION_RE.test(w.value))) return false;
  return operands.some((w) => DEFINITION_RE.test(w.value));
}
