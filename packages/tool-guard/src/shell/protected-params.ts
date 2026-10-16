import { HOOKED } from "./hooked-names.js";

/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name; `command-rebinding.ts` lists the same. */
const REBINDING_NAMES = ["commands", "BASH_CMDS", "functions", "dis_functions", "nameddirs"];
/** Tables whose elements define a command word: an alias set through an expansion rewrites a later command. */
const ALIAS_TABLES = ["aliases", "galiases", "saliases", "BASH_ALIASES"];

/** Parameters an assignment must not reach through an expansion: `options` holds every zsh option, among them GLOB_SUBST. */
export const PROTECTED: ReadonlySet<string> = new Set([...HOOKED, ...REBINDING_NAMES, ...ALIAS_TABLES, "options"]);
