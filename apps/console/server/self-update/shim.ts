import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SHIM_NAME = "titan-console";
const SHIM_MODE = 0o755;

export const shimPath = (binDir: string): string => path.join(binDir, SHIM_NAME);

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Points at `current/`, never a release, so a rollback's swap keeps it valid with no rewrite. */
export function shimText(root: string): string {
  const cli = path.join(root, "current", "apps/console/dist/cli.js");
  return `#!/bin/sh\nexec node ${shQuote(cli)} "$@"\n`;
}

function unchanged(file: string, text: string): boolean {
  try {
    return readFileSync(file, "utf8") === text && (statSync(file).mode & 0o777) === SHIM_MODE;
  } catch {
    return false;
  }
}

/** False when `file` already holds `text`; otherwise renames a fresh executable over it, so a reader never sees half a script. */
export function writeShim(file: string, text: string): boolean {
  if (unchanged(file, text)) return false;
  const fresh = `${file}.${process.pid}.new`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(fresh, text, { mode: SHIM_MODE });
    chmodSync(fresh, SHIM_MODE);
    renameSync(fresh, file);
  } finally {
    rmSync(fresh, { force: true });
  }
  return true;
}
