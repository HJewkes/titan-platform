import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isFactEntry, type StepEntry } from "./entry.js";

/** Rows live one file per PR, `bumps/<pr>.json`, so two PRs bumping one step never write the same line (TP-5705). */
export const BUMPS_DIR = "products/factory/src/registry/bumps";
const PR_FILE = /^[1-9][0-9]*\.json$/;

const bumpRowsSchema = z.array(z.strictObject({ step: z.string().min(1), pr: z.number().int().positive() }));
/** PR `pr` changed `step`'s behaviour: the step's version moves by one for it. */
export type BumpRow = z.infer<typeof bumpRowsSchema>[number];

/** The checkout this module runs from: src/ and dist/ both sit under the directory holding pnpm-workspace.yaml. */
export function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** Every `<pr>.json` row under `root`; a checkout with no bump yet has no directory and no rows. */
export function readBumpRows(root: string = workspaceRoot()): BumpRow[] {
  const dir = join(root, BUMPS_DIR);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((name) => PR_FILE.test(name));
  return names.flatMap((name) => bumpRowsSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

/**
 * A fact entry's declared bump plus one per distinct PR whose row names it. Each PR adds its own row, so a PR that lands
 * first moves the sum without making a concurrent PR's row stale: both count once the second lands.
 */
export function withRecordedBumps(entries: readonly StepEntry[], rows: readonly BumpRow[]): StepEntry[] {
  return entries.map((entry) => {
    if (!isFactEntry(entry)) return entry;
    const prs = new Set(rows.filter((row) => row.step === entry.name).map((row) => row.pr));
    return prs.size === 0 ? entry : { ...entry, version: { bump: entry.version.bump + prs.size } };
  });
}
