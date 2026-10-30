import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sha256 } from "./workflow/artifacts.js";
import { CACHED_STAGES, type CachedStage } from "./workflow/records.js";

/**
 * One file per change, so two pull requests that each re-key a stage add two files instead of racing for the next
 * value on one line. Its name is its id; only `stages` reaches a key, so `why` can be reworded freely.
 */
const StageBumpSchema = z.strictObject({
  stages: z.array(z.enum(CACHED_STAGES)).min(1).refine((stages) => new Set(stages).size === stages.length, "a stage is listed twice"),
  why: z.string().min(1),
});

interface StageBump {
  id: string;
  stages: readonly CachedStage[];
}

const DEFAULT_STAGE_BUMPS_DIR = fileURLToPath(new URL("../stage-bumps/", import.meta.url));
const STAGE_BUMP_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Every `<id>.json` in the directory; any other file (the README) is not a bump. */
export function loadStageBumps(dir: string = DEFAULT_STAGE_BUMPS_DIR): StageBump[] {
  return readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => {
    const id = path.basename(file, ".json");
    if (!STAGE_BUMP_ID.test(id)) throw new Error(`stage bump ${file}: the id must be letters, digits and hyphens`);
    const parsed = StageBumpSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`stage bump ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return { id, stages: parsed.data.stages };
  });
}

/**
 * A stage no bump names keeps its base value, so a stored run's keys survive; a bumped one appends a hash of its bump
 * ids, which is the same whichever order the pull requests merged in.
 */
export function stageVersions(base: Readonly<Record<CachedStage, string>>, bumps: readonly StageBump[]): Record<CachedStage, string> {
  const versions = { ...base };
  for (const stage of CACHED_STAGES) {
    const ids = bumps.filter((bump) => bump.stages.includes(stage)).map((bump) => bump.id).sort();
    if (ids.length > 0) versions[stage] = `${base[stage]}.${sha256(ids.join("\n")).slice(0, 10)}`;
  }
  return versions;
}
