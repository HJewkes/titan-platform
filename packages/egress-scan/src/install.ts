import * as fs from "node:fs";
import * as path from "node:path";
import { isCi } from "./config.js";
import { hooksDir } from "./git.js";

export const HOOK_MARKER = "# titan-egress-scan managed pre-push hook";

export type InstallOutcome = "installed" | "updated" | "unchanged" | "skipped-in-ci" | "foreign-hook";

export interface InstallResult {
  readonly outcome: InstallOutcome;
  readonly hookPath?: string;
}

/** The shipped hook body, one directory above both `src/` and `dist/`. */
export function hookBody(): string {
  return fs.readFileSync(new URL("../hooks/pre-push", import.meta.url), "utf-8");
}

function existing(hookPath: string): string | undefined {
  return fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf-8") : undefined;
}

/**
 * Writes the pre-push hook into git's hooks directory, which honours `core.hooksPath` and is
 * shared by every linked worktree. It never sets `core.hooksPath` and never replaces a hook it
 * did not write.
 */
export function installHook(cwd: string, env: Readonly<Record<string, string | undefined>>): InstallResult {
  if (isCi(env)) return { outcome: "skipped-in-ci" };
  const hookPath = path.join(hooksDir(cwd), "pre-push");
  const body = hookBody();
  const current = existing(hookPath);
  if (current !== undefined && !current.includes(HOOK_MARKER)) return { outcome: "foreign-hook", hookPath };
  if (current === body) return { outcome: "unchanged", hookPath };
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, body, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  return { outcome: current === undefined ? "installed" : "updated", hookPath };
}
