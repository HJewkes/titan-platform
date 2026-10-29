import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** One sunset-manifest default or entry under agent-chat `src`: the old path a slice should not grow without a carve-out. */
export interface OldPathRule {
  path: string;
  fate: string;
  task?: string;
}

const ManifestRow = z.object({ repo: z.string(), path: z.string(), fate: z.string(), task: z.string().optional() });
const Manifest = z.object({ defaults: z.array(ManifestRow).default([]), entries: z.array(ManifestRow).default([]) });

const MANIFEST = join("sunset", "manifest.json");

/** The sunset manifest from the factory package root, found by walking up because src and the bundled dist sit at different depths. */
export function findSunsetManifest(from = dirname(fileURLToPath(import.meta.url))): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, MANIFEST))) return join(dir, MANIFEST);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The manifest's agent-chat `src` rows, so the plan-time warning and the sunset check read one list. Empty when no manifest is found. */
export function agentChatOldPaths(manifestPath = findSunsetManifest()): OldPathRule[] {
  if (manifestPath === undefined) return [];
  const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  return [...manifest.defaults, ...manifest.entries]
    .filter((row) => row.repo === "agent-chat" && (row.path === "src" || row.path.startsWith("src/")))
    .map(({ path, fate, task }) => ({ path, fate, task }));
}
