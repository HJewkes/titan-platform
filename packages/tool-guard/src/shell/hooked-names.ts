/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
export const HOOKED: ReadonlySet<string> = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);

/** A hooked name as a whole identifier: `PS4` in `PS4=1` or `x+PS4`, not in `PS44` or `MY_PS4`. */
export const HOOKED_MENTION_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${[...HOOKED].join("|")})(?![A-Za-z0-9_])`, "g");
