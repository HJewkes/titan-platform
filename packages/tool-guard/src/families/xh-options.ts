import { set } from "./options.js";

/**
 * xh's options that take a value, from xh's src/cli.rs at tag v0.26.2, including the `--unstable-m-sig-*` options
 * that default builds hide from `--help` but clap still accepts. A missing entry would let its value read as the
 * method or URL.
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
  "--unstable-m-sig-id",
  "--unstable-m-sig-key",
  "--unstable-m-sig-alg",
  "--unstable-m-sig-comp",
);
