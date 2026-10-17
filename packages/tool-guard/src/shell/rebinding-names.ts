/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name. */
export const REBINDING = ["commands", "BASH_CMDS", "functions", "dis_functions", "nameddirs"];
export const REBINDING_SET: ReadonlySet<string> = new Set(REBINDING);
