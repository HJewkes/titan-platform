import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** The directory diagnostics are reported relative to, resolved so it matches the real paths tools print. */
export function auditRoot(cwd?: string): string {
  return realpathSync(cwd ?? process.cwd());
}

export function relativeTo(root: string, file: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}
