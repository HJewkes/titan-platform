import type { WordToken } from "./lexer.js";
import { mayGenerate } from "./word-generation.js";

/** How a builtin whose options name, or decide, the parameter it stores into reads its option words. */
interface StoreOptionBuiltin {
  /** The option letters that store into a parameter, or make an operand one; empty when only an operand names it. */
  stores: string;
  /**
   * Letters that take the next word as their value in bash or zsh, when nothing is attached. The union of both shells
   * and of optional values, so a word the guard reads as a value is never an option word to the shell.
   */
  values: string;
  /** zsh skips one leading `--` and still reads options after it: `zparseopts -- -A commands y:`. */
  skipsLeadingDashes?: true;
  /** Where the manuals document the store. */
  source: string;
}

/**
 * Every builtin with a store option, from zshbuiltins(1), zshmodules(1), zshzle(1) and bash(1) as of zsh 5.9 and
 * bash 5.3. Left out on purpose: the declarers (`typeset`, `declare`, `export`, `local`, `readonly`, `private`,
 * `integer`, `float`), whose operands are names in every position, so an option adds no store; `zle -M`, which prints;
 * and builtins that store only through operands (`zcurses`, `zgetattr`, `zlistattr`, `zregexparse`, `ztie`, `shift`).
 */
export const STORE_OPTION_BUILTINS: ReadonlyMap<string, StoreOptionBuiltin> = new Map(Object.entries({
  print: { stores: "v", values: "vufCxX", source: "zshbuiltins(1) SHELL BUILTIN COMMANDS: print -v name" },
  printf: { stores: "v", values: "v", source: "zshbuiltins(1) printf -v name; bash(1) SHELL BUILTIN COMMANDS: printf -v var" },
  set: { stores: "A", values: "Ao", source: "zshbuiltins(1) set {+|-}A name" },
  read: { stores: "aA", values: "adiknNptu", source: "zshbuiltins(1) read -A; bash(1) read -a aname" },
  getln: { stores: "A", values: "", source: "zshbuiltins(1) getln -A" },
  getopts: { stores: "", values: "", skipsLeadingDashes: true, source: "zshbuiltins(1) and bash(1) getopts optstring name" },
  zmodload: { stores: "P", values: "P", source: "zshbuiltins(1) zmodload -F -P param" },
  vared: { stores: "aA", values: "prMmift", source: "zshzle(1) ZLE BUILTINS: vared -a, -A" },
  zparseopts: { stores: "aAv", values: "aAv", skipsLeadingDashes: true, source: "zshmodules(1) The zsh/zutil Module: zparseopts -a array, -A assoc" },
  zformat: { stores: "faF", values: "faF", skipsLeadingDashes: true, source: "zshmodules(1) The zsh/zutil Module: zformat -f param, -F param, -a array" },
  zstyle: { stores: "absg", values: "", skipsLeadingDashes: true, source: "zshmodules(1) The zsh/zutil Module: zstyle -a, -b, -s, -g name" },
  strftime: { stores: "s", values: "s", source: "zshmodules(1) The zsh/datetime Module: strftime -s scalar" },
  zstat: { stores: "AH", values: "AHfF", source: "zshmodules(1) The zsh/stat Module: zstat -A array, -H hash" },
  zselect: { stores: "aA", values: "aAt", source: "zshmodules(1) The zsh/zselect Module: zselect -a array, -A assoc" },
  pcre_match: { stores: "va", values: "van", source: "zshmodules(1) The zsh/pcre Module: pcre_match -v var, -a arr" },
  sysread: { stores: "c", values: "ciost", source: "zshmodules(1) The zsh/system Module: sysread -c countvar" },
  syswrite: { stores: "c", values: "co", source: "zshmodules(1) The zsh/system Module: syswrite -c countvar" },
  sysopen: { stores: "u", values: "umo", source: "zshmodules(1) The zsh/system Module: sysopen -u fd" },
  syserror: { stores: "e", values: "ep", source: "zshmodules(1) The zsh/system Module: syserror -e errvar" },
  zpty: { stores: "r", values: "", source: "zshmodules(1) The zsh/zpty Module: zpty -r name param" },
  compgen: { stores: "V", values: "VAGWFCXPSo", source: "bash(1) SHELL BUILTIN COMMANDS: compgen -V varname" },
  mapfile: { stores: "", values: "dnOsuCc", source: "bash(1) SHELL BUILTIN COMMANDS: mapfile [array]" },
  readarray: { stores: "", values: "dnOsuCc", source: "bash(1) SHELL BUILTIN COMMANDS: readarray [array]" },
  wait: { stores: "p", values: "p", source: "bash(1) SHELL BUILTIN COMMANDS: wait -p varname" },
}));

/** A first character no expansion produced, so every word the word yields starts with it and none is an option. */
const LITERAL_LEAD_RE = /^[A-Za-z0-9_./]/;
/** A special parameter that is always a number or empty: `wait $!`. */
const NUMERIC_SPECIAL_RE = /^\$[!$#?]$/;

/**
 * Whether a store builtin may read a run-time word as an option: one where options are still read, before a literal
 * `--` or the first word that cannot be an option, that expands, globs or brace-expands to text that may start with
 * `-` or `+`. Quotes do not help: `set "$x"` with `x=-Acommands` stores in zsh. An unquoted option value counts too,
 * since it may split into options (`print -u $fd`). Writing `--` first (`print -- $x`) is how a line passes.
 */
export function expandsInStoreOptions(name: string, args: WordToken[]): boolean {
  const spec = STORE_OPTION_BUILTINS.get(name);
  if (!spec) return false;
  const words = spec.skipsLeadingDashes && args[0]?.value === "--" && !expands(args[0]) ? args.slice(1) : args;
  let valueNext = false;
  for (const word of words) {
    if (expands(word)) {
      if (valueNext ? splits(word) : mayStartOption(word)) return true;
      if (!valueNext) return false;
      valueNext = false;
      continue;
    }
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (word.value === "--" || !/^[-+]./s.test(word.value)) return false;
    valueNext = takesNextWord(word.value, spec.values);
  }
  return false;
}

function expands(word: WordToken): boolean {
  return word.dynamic || word.unquotedExpansion === true || mayGenerate(word);
}

/** An unquoted expansion or a generated word, either of which may become several words. */
function splits(word: WordToken): boolean {
  return word.unquotedExpansion === true || mayGenerate(word);
}

function mayStartOption(word: WordToken): boolean {
  if (NUMERIC_SPECIAL_RE.test(word.value)) return false;
  const expandedLead = word.refs.some((r) => r.start === 0) || (word.cuts ?? []).some((c) => c.at === 0);
  return expandedLead || !LITERAL_LEAD_RE.test(word.value);
}

/** Whether the cluster ends in a letter that takes a value, so the next word is that value: `-ru` then `3`. */
function takesNextWord(cluster: string, values: string): boolean {
  const letters = cluster.slice(1);
  const at = [...letters].findIndex((c) => values.includes(c));
  return at === letters.length - 1;
}
