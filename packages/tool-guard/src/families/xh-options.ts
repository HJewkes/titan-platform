import { set } from "./options.js";

/**
 * xh's options that take a value, from the `xh --help` text of xh 0.24 (not checked against a binary).
 * A missing entry would let its value read as the method or URL, so the table errs toward listing too many.
 * Unlike curl, xh's `-F` (follow), `-f` (form), `-d` (download), `-b` (body), `-c` (continue) and `-x` (compress)
 * are switches.
 */
export const XH_VALUES = set(
  "-a", "--auth",
  "-A", "--auth-type",
  "--bearer",
  "-o", "--output",
  "--session",
  "--session-read-only",
  "-p", "--print",
  "-P", "--history-print",
  "-s", "--style",
  "--pretty",
  "--response-charset",
  "--response-mime",
  "--format-options",
  "--raw",
  "--max-redirects",
  "--timeout",
  "--proxy",
  "--verify",
  "--cert",
  "--cert-key",
  "--ssl",
  "--http-version",
  "--resolve",
  "--interface",
  "--unix-socket",
  "--default-scheme",
  "--generate",
);
