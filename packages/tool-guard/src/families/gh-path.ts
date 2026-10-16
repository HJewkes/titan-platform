import type { SimpleCommand } from "../shell/commands.js";
import { ghCommandLine } from "./gh-words.js";

/** Variables that point gh at another `config.yml`, whose aliases the guard cannot know. */
const CONFIG_ENV = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"];

/**
 * Whether what gh runs is only known at run time: a word cobra may read as a command word is unknown or may split,
 * the command words end on a word gh may run as a config alias or an extension (`gh m 1`, `gh co 5`, `gh pr x 5`),
 * or a prefix assignment points gh at another config.
 */
export function ghPathUnknown(cmd: Pick<SimpleCommand, "args" | "env">): boolean {
  const { hidden, aliasSlot } = ghCommandLine(cmd.args);
  return hidden || aliasSlot || CONFIG_ENV.some((name) => Object.hasOwn(cmd.env, name));
}
