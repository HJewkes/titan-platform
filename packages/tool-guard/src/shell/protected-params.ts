import { HOOKED } from "./hooked-names.js";
import { REBINDING } from "./rebinding-names.js";

/** Tables whose elements define a command word: an alias set through an expansion rewrites a later command. */
const ALIAS_TABLES = ["aliases", "galiases", "saliases", "BASH_ALIASES", "dis_aliases", "dis_galiases", "dis_saliases"];

/** Parameters a shell, or a child shell or program, reads as code or as a search path: an assignment through an expansion runs attacker text later. */
export const EXEC_HOOKS: readonly string[] = [
  "PS0", "PS1", "PS2", "PS3", "PROMPT", "prompt", "PROMPT2", "PROMPT3", "RPS1", "RPS2", "RPROMPT", "RPROMPT2", "SPROMPT", "PROMPT_COMMAND",
  "precmd_functions", "preexec_functions", "chpwd_functions", "periodic_functions", "zshaddhistory_functions", "zshexit_functions", "zsh_directory_name_functions",
  "BASH_ENV", "ENV", "ZDOTDIR", "HOME", "SHELLOPTS", "BASHOPTS",
  "FPATH", "fpath", "BASH_LOADABLES_PATH",
  "PATH", "path", "NULLCMD", "READNULLCMD", "EXECIGNORE",
  "IFS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "mapfile",
];

/** Parameters an assignment must not reach through an expansion: `options` holds every zsh option, among them GLOB_SUBST. */
export const PROTECTED: ReadonlySet<string> = new Set([...HOOKED, ...REBINDING, ...ALIAS_TABLES, ...EXEC_HOOKS, "options"]);
