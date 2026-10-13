import { splitCluster } from "./cluster.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * Whether bash `enable` may dlopen a shared object, whose constructors run native code the guard never reads.
 * `enable -f FILE NAME` loads FILE, and since bash 5.1 `enable NAME` searches `BASH_LOADABLES_PATH`, whose default
 * includes `.`, so any operand counts as a load. Only the listing forms (`enable`, `-a`, `-p`, `-s`, `-n`) pass.
 */
export function loadsNativeCode(cmd: Unwrapped): boolean {
  if (cmd.name !== "enable") return false;
  if (cmd.args.some((w) => w.dynamic)) return true;
  let options = true;
  for (const word of cmd.args) {
    if (options && word.value === "--") options = false;
    else if (!options) return true;
    else {
      const cluster = splitCluster(word.value, { values: ["-f"] });
      if (!cluster || cluster.end) return true;
    }
  }
  return false;
}
