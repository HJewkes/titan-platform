import { spawnSync } from "node:child_process";
import type { FunctionTable, SnapshotFunction } from "./snapshot-functions.js";

/** True when the shell parses the script. It must never run it. */
export type ParseCheck = (script: string) => boolean;

const PARSE_TIMEOUT_MS = 2000;
const UNREADABLE: SnapshotFunction = { unreadable: true };

/**
 * `-n` reads without executing and `-f` skips the user's startup files. A missing zsh, a timeout or a non-zero exit
 * all count as a failed parse.
 */
export function zshParses(script: string): boolean {
  const run = spawnSync("zsh", ["-f", "-n"], { input: script, stdio: ["pipe", "ignore", "ignore"], timeout: PARSE_TIMEOUT_MS });
  return run.error === undefined && run.status === 0;
}

/**
 * Looks up a function, trusting its body only if zsh parses it standalone, and so does every body before it. A body
 * the scanner cut short fails its own parse. The functions after a cut body are made up from its verbatim text, and
 * one of those can parse, so a cut anywhere earlier makes every later body untrusted. Parses run lazily, once per
 * body, and only up to the furthest function looked up. A name absent from the table is returned as undefined, and
 * the table's `incomplete` still decides what that means.
 */
export function trustedFunctions(table: FunctionTable, parses: ParseCheck = zshParses): (name: string) => SnapshotFunction | undefined {
  const order = [...table.functions.keys()];
  let parsed = 0;
  let firstFailure = Infinity;
  return (name) => {
    const fn = table.functions.get(name);
    if (fn === undefined) return undefined;
    const index = order.indexOf(name);
    for (; parsed <= index && firstFailure === Infinity; parsed++) {
      const prior = order[parsed] ?? "";
      if (!parsesStandalone(prior, table.functions.get(prior), parses)) firstFailure = parsed;
    }
    return index < firstFailure ? fn : UNREADABLE;
  };
}

function parsesStandalone(name: string, fn: SnapshotFunction | undefined, parses: ParseCheck): boolean {
  return fn !== undefined && "body" in fn && parses(`${name} () {\n${fn.body}\n}`);
}
