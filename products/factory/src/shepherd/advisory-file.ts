import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdvisoryMemory } from "./advisory.js";

const ADVISORY_FILE = "shepherd-advisory.json";

const isRepoList = (value: unknown): value is string[] => Array.isArray(value) && value.every((repo) => typeof repo === "string");

/** The last good advisory set, kept in the factory state dir; a missing or unreadable file loads as no memory at all. */
export function advisoryFile(stateDir: string): AdvisoryMemory {
  const path = join(stateDir, ADVISORY_FILE);
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { advisory?: unknown } | null;
        return isRepoList(parsed?.advisory) ? parsed.advisory : undefined;
      } catch {
        return undefined;
      }
    },
    save: (repos) => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify({ advisory: repos })}\n`);
      renameSync(`${path}.tmp`, path);
    },
  };
}
