/**
 * How a name-writing builtin reads its words, as the union of bash and zsh. Each string lists option letters; a
 * letter in none of them is unknown, and the command then fails closed. `name-slots.ts` and `hooked-params.ts` both
 * read this one table, so a builtin one of them knows is never missing from the other.
 */
export interface WriterSpec {
  /** Options whose value, attached or next, is a name the command writes. */
  names?: string;
  /** Options whose value, attached or next, is not a name. */
  values?: string;
  /** Options that take a value in one shell and are a flag in the other, so the next word may be a name. */
  either?: string;
  /** zsh options with an optional attached number, such as `typeset -L10`. */
  numeric?: string;
  flags?: string;
  /** Whether every other letter or digit is a flag, as for `set`. */
  anyFlag?: boolean;
  /** Whether a `+` cluster is an option word too. */
  plus?: boolean;
  /** Whether a `--name` word is an option of another command of the same name, which writes no name. */
  longOptions?: boolean;
  /** Which operands are names: all of them, none, or each zparseopts spec's array after `=`. */
  operands: "names" | "none" | "specs";
  /** Leading operands that are not names, such as the file operand of `zlistattr`. */
  skip?: number;
}

export const DECLARE: WriterSpec = { flags: "aAfFgGhHiIklLmnprRtTuUxzEZ", numeric: "EFLRZip", plus: true, operands: "names" };

const ZSTAT: WriterSpec = { names: "AH", values: "fF", flags: "gnNolLtTrs", operands: "none" };

/** zsh/computil's builtins name the arrays they fill in operands whose positions depend on the mode, so each operand counts. */
const COMPLETION_INTERNAL: WriterSpec = { anyFlag: true, operands: "names" };

/**
 * Every bash 5.3 and zsh 5.9 builtin whose operands or option values name a parameter it writes or removes, apart from
 * `for`, `select` and `getopts`, which each reader slots by position. Sources: bash(1) SHELL BUILTIN COMMANDS,
 * zshbuiltins(1), zshmodules(1) and zshcompwid(1).
 */
export const WRITER_SPECS: Readonly<Record<string, WriterSpec>> = {
  export: DECLARE, declare: DECLARE, typeset: DECLARE, local: DECLARE, readonly: DECLARE, private: DECLARE,
  integer: DECLARE, float: DECLARE,
  unset: { flags: "fvn", operands: "names" },
  read: { names: "a", values: "diNu", either: "npt", numeric: "k", flags: "ersqzcAlE", operands: "names" },
  mapfile: { values: "dnOsuCc", flags: "t", operands: "names" },
  readarray: { values: "dnOsuCc", flags: "t", operands: "names" },
  printf: { names: "v", operands: "none" },
  print: { names: "v", values: "CfuxX", flags: "abcDilmnNoOpPrRsSz", operands: "none" },
  set: { names: "A", values: "o", anyFlag: true, plus: true, operands: "none" },
  wait: { names: "p", flags: "nf", operands: "none" },
  compgen: { names: "V", values: "AGWFCXPSo", flags: "abcdefgjksuv", operands: "none" },
  vared: { values: "prMmift", flags: "Aacghe", operands: "names" },
  zstyle: { flags: "sabtTmgedL", operands: "names" },
  zparseopts: { names: "aAv", flags: "DEFKM", operands: "specs" },
  zformat: { names: "faF", operands: "none" },
  strftime: { names: "s", flags: "rqn", operands: "none" },
  zstat: ZSTAT,
  /** zsh/stat's builtin shares its name with GNU and BSD stat: `-t` and BSD `-f` take a format, GNU `-f` and BSD `-F` are flags. */
  stat: { ...ZSTAT, values: "c", either: "fFt", flags: "gnNolLTrsqx", longOptions: true },
  zselect: { names: "aA", values: "t", flags: "rwe", operands: "none" },
  getln: { flags: "AclneE", operands: "names" },
  sysread: { names: "c", values: "iost", operands: "names" },
  zregexparse: { flags: "c", operands: "names" },
  pcre_match: { names: "va", values: "n", flags: "b", operands: "none" },
  zpty: { flags: "ebdtLrwnm", skip: 1, operands: "names" },
  zsystem: { operands: "names" },
  syserror: { names: "e", values: "p", operands: "none" },
  sysopen: { names: "u", values: "mo", flags: "arw", operands: "none" },
  syswrite: { names: "c", values: "o", operands: "none" },
  zmodload: { names: "P", flags: "dLsiFabcpfIeARulm", operands: "none" },
  zgetattr: { flags: "h", skip: 2, operands: "names" },
  zlistattr: { flags: "h", skip: 1, operands: "names" },
  ztie: { values: "df", flags: "rzZS", operands: "names" },
  zcurses: { operands: "names" },
  shift: { flags: "p", operands: "names" },
  compadd: { names: "OAD", values: "PSpsiIWdJVXxrRMEF", either: "o", flags: "UQqaklfn12C", operands: "none" },
  comparguments: COMPLETION_INTERNAL, compvalues: COMPLETION_INTERNAL, compdescribe: COMPLETION_INTERNAL,
  comptags: COMPLETION_INTERNAL, compfiles: COMPLETION_INTERNAL,
  compquote: { flags: "p", operands: "names" },
};

/** Builtins in the table that only remove a name, so no value they leave behind can be a hooked one. */
export const REMOVERS: ReadonlySet<string> = new Set(["unset"]);

/** Declarers whose `-n` makes each operand a nameref, so its target names the variable later writes reach. */
export const NAMEREF_DECLARERS: ReadonlySet<string> = new Set(["declare", "typeset", "local", "private"]);

export function writerSpec(name: string): WriterSpec | undefined {
  return Object.hasOwn(WRITER_SPECS, name) ? WRITER_SPECS[name] : undefined;
}
