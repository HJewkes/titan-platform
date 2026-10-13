import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { ReadingLimitError } from "./unsure-readings.js";

/** zsh's alias tables as parameters: a store into any of them defines an alias without the `alias` builtin. */
const ALIAS_PARAMS = new Set(["aliases", "galiases", "saliases", "dis_aliases", "dis_galiases", "dis_saliases"]);
/** A word naming an alias parameter as the target of a store: `aliases`, `aliases[y]`, `galiases+=x`. */
const STORED_PARAM_RE = /^(?:dis_)?[gs]?aliases(?:\[|\+?=|$)/;
/** An alias parameter inside a `${ }` expansion, which the lexer leaves without refs once it holds zsh flags or `::=`. */
const EXPANDED_PARAM_RE = /\$\{[^}]*?(?<![A-Za-z0-9_])(?:dis_)?[gs]?aliases(?![A-Za-z0-9_])/;
/** Builtins that store into a parameter their arguments name. */
const STORE_BUILTINS = new Set([
  "typeset", "declare", "local", "export", "readonly", "integer", "float", "set",
  "read", "print", "printf", "zparseopts", "vared", "getopts", "unset",
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

/** Whether the command defines or may define an alias that text zsh parses later in the same process would expand. */
export function definesAlias(cmd: Unwrapped): boolean {
  return (
    (cmd.name === "alias" && aliasOperands(cmd.args).some((w) => w.dynamic || w.value.includes("=")))
    || (cmd.name === "enable" && enablesAliases(cmd.args))
    || cmd.assigned.some(([name]) => ALIAS_PARAMS.has(name))
    || cmd.args.some(expandsAliasParam)
    || (cmd.name !== null && STORE_BUILTINS.has(cmd.name) && cmd.args.some((w) => STORED_PARAM_RE.test(w.value)))
    || (cmd.name === null && dynamicDefinition(cmd.args.slice(1)))
  );
}

/** The operands of `alias`: every word after its options, which run up to `--` or the first word not led by `-` or `+`. */
function aliasOperands(args: WordToken[]): WordToken[] {
  const at = args.findIndex((w) => w.value === "--" || w.dynamic || !/^[-+]./.test(w.value));
  if (at === -1) return [];
  return args.slice((args[at] as WordToken).value === "--" ? at + 1 : at);
}

/** `enable -a` turns disabled aliases back on; zsh reads its options up to `--` or the first operand. */
function enablesAliases(args: WordToken[]): boolean {
  for (const w of args) {
    if (w.dynamic) return true;
    if (w.value === "--" || !w.value.startsWith("-")) return false;
    if (w.value.slice(1).includes("a")) return true;
  }
  return false;
}

function expandsAliasParam(w: WordToken): boolean {
  return w.refs.some((ref) => ALIAS_PARAMS.has(ref.name)) || (w.dynamic && EXPANDED_PARAM_RE.test(w.value));
}

/**
 * A dynamic command word may be `alias`, so a `NAME=VALUE` operand may define one. The words are read with alias's own
 * options only: any other option word means the command is something else, as in `"$PY" -c x=1`.
 */
function dynamicDefinition(args: WordToken[]): boolean {
  for (const w of args) {
    if (w.value === "--") continue;
    if (w.value.startsWith("-") || w.value.startsWith("+")) {
      if (!ALIAS_OPTION_RE.test(w.value)) return false;
    } else if (DEFINITION_RE.test(w.value)) return true;
  }
  return false;
}
