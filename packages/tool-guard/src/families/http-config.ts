import type { SimpleCommand } from "../shell/commands.js";

/** Variables that choose which config file wget or curl reads. */
const CONFIG_VARS = ["WGETRC", "SYSTEM_WGETRC", "CURL_HOME", "XDG_CONFIG_HOME", "HOME"];
/** In the typed text, which still holds a prefix assignment with a run-time value that the extracted commands drop. */
const TEXT_ASSIGNS_RE = new RegExp(`(?<![\\w$])(?:${CONFIG_VARS.join("|")})\\+?=`);
/** In a word with quotes removed: an `export`, `declare -x` or `env` argument. */
const WORD_ASSIGNS_RE = new RegExp(`^(?:${CONFIG_VARS.join("|")})\\+?=`);
/** A wget or curl config file: `.wgetrc`, `/etc/wgetrc`, `.curlrc`, `$XDG_CONFIG_HOME/curlrc`. */
const RC_FILE_RE = /(?:wget|curl)rc/;

/**
 * Whether the line may choose or write the config file wget or curl reads, which can set any method and URL: it
 * assigns one of `CONFIG_VARS` in any form, or names an rc file anywhere, as a redirect, `tee` or `cp` would.
 */
export function choosesHttpConfig(src: string, commands: SimpleCommand[]): boolean {
  if (TEXT_ASSIGNS_RE.test(src) || RC_FILE_RE.test(src)) return true;
  return commands.some((cmd) => {
    const words = [...Object.keys(cmd.env).map((k) => `${k}=`), ...cmd.args.map((a) => a.value), ...cmd.redirects.map((r) => r.target?.value ?? "")];
    return words.some((w) => WORD_ASSIGNS_RE.test(w) || RC_FILE_RE.test(w));
  });
}
