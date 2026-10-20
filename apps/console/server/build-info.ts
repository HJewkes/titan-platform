import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readCommand } from "./owner-guard.js";
import { APP_DIR } from "./paths.js";

/** Written by `build` after vite and tsup, so it names the commit the served dist was built from. */
export const BUILD_INFO_FILE = path.join(APP_DIR, "dist", "build-info.json");

export const buildInfoSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  builtAt: z.string(),
  /** The checkout had tracked changes, so `sha` alone does not reproduce the build. */
  dirty: z.boolean(),
});

export type BuildInfo = z.infer<typeof buildInfoSchema>;

/** Null when the file is missing or malformed: a dev server or an unstamped build has no sha to show. */
export function readBuildInfo(file: string = BUILD_INFO_FILE): BuildInfo | null {
  try {
    const parsed = buildInfoSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface GitFacts {
  head: string;
  /** `git status --porcelain --untracked-files=no` output. */
  status: string;
}

export function buildInfoOf(git: GitFacts, now: Date): BuildInfo {
  return buildInfoSchema.parse({ sha: git.head.trim(), builtAt: now.toISOString(), dirty: git.status.trim() !== "" });
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
