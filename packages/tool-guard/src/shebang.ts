/** What running a file by path hands the kernel: no `#!` line, a shell the guard knows to read the body as, or a line it cannot follow. */
export type Shebang = { kind: "none" } | { kind: "shell"; shell: string; flags: string } | { kind: "opaque" };

const SHELL_LINE_RE = /^#!(?:\/usr)?\/bin\/(bash|sh|zsh)(?: -([euxvf]+))?$/;
const ENV_LINE_RE = /^#!\/usr\/bin\/env (bash|sh|zsh)$/;
/** Only blanks and invisible marks before `#!`: a BOM or NBSP there is no shebang to the kernel, but a tool that strips it would see one. */
const PADDED_RE = /^[\p{Z}\p{C}\s]*#!/u;

/**
 * Reads a script's first line the way the kernel hands it on. The kernel passes everything after the interpreter to it
 * as options and operands, and the interpreter's own parser then reads them again, so only the short positive list
 * below is followed: `#!/bin/bash`, `#!/usr/bin/env bash` and one `-[euxvf]+` word on the first form. Anything else is
 * opaque, since the body may not be what runs.
 */
export function parseShebang(text: string): Shebang {
  const line = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  if (!line.startsWith("#!")) return PADDED_RE.test(line) ? { kind: "opaque" } : { kind: "none" };
  const [, shell = "", flags = ""] = SHELL_LINE_RE.exec(line) ?? [];
  if (shell !== "") return { kind: "shell", shell, flags };
  const [, envShell = ""] = ENV_LINE_RE.exec(line) ?? [];
  return envShell === "" ? { kind: "opaque" } : { kind: "shell", shell: envShell, flags: "" };
}
