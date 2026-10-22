import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readCommand } from "./owner-guard.js";
import { APP_DIR } from "./paths.js";

/** Written by `build` after vite and tsup, so it names the commit the served dist was built from. */
export const BUILD_INFO_FILE = path.join(APP_DIR, "dist", "build-info.json");

const buildInfoSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  builtAt: z.string(),
  /** The checkout had tracked changes, so `sha` alone does not reproduce the build. */
  dirty: z.boolean(),
});

type BuildInfo = z.infer<typeof buildInfoSchema>;

/** Null when the file is missing or malformed: a dev server or an unstamped build has no sha to show. */
export function readBuildInfo(file: string = BUILD_INFO_FILE): BuildInfo | null {
  try {
    const parsed = buildInfoSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface GitFacts {
  head: string;
  /** `git status --porcelain --untracked-files=no` output. */
  status: string;
}

export function buildInfoOf(git: GitFacts, now: Date): BuildInfo {
  return buildInfoSchema.parse({ sha: git.head.trim(), builtAt: now.toISOString(), dirty: git.status.trim() !== "" });
}

/**
 * Stamps the commit the dist was built from. A build must not fail because git is unavailable (no `.git`,
 * or a checkout owned by another user), so then the file is removed, never left stale, and readers see
 * the unstamped build they already handle.
 */
export function stampBuildInfo(git: (args: string[]) => string, file: string, now: Date, warn: (message: string) => void): BuildInfo | null {
  try {
    const info = buildInfoOf({ head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain", "--untracked-files=no"]) }, now);
    writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
    return info;
  } catch (error) {
    rmSync(file, { force: true });
    warn(`build not stamped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return null;
  }
}

export function buildInfoCommands(file: string = BUILD_INFO_FILE) {
  return {
    "console.build": readCommand({
      name: "console.build",
      description: "The commit and time the served console was built from, or null when the build was not stamped",
      args: z.object({}),
      result: z.object({ build: buildInfoSchema.nullable() }),
      run: async () => ({ build: readBuildInfo(file) }),
    }),
  };
}
