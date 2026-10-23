import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ANCHOR_ID_PATTERN, type Stage } from "./anchor-grid.js";
import type { OccupancyTable } from "./occupancy-table.js";

/** `occupancy.json` sits next to `qa.json`, so the lints and the critic read one render's tables from one place. */
export const OCCUPANCY_FILE = "occupancy.json";

const Cells = z.record(z.string().regex(ANCHOR_ID_PATTERN, "expected an anchor cell from A1 to F6"), z.array(z.string().min(1)).min(1));

export const OccupancyFileSchema = z
  .object({
    schema: z.literal("occupancy/v1"),
    stage: z.object({ width: z.number().positive(), height: z.number().positive() }).strict(),
    tables: z.array(
      z
        .object({ mark: z.string().min(1), beat: z.string().min(1), t: z.number().nonnegative(), source: z.enum(["dom", "declared", "pixel"]), cells: Cells })
        .strict(),
    ),
  })
  .strict();

export type OccupancyFile = z.infer<typeof OccupancyFileSchema>;

export function occupancyPathFor(qaJsonPath: string): string {
  return join(dirname(qaJsonPath), OCCUPANCY_FILE);
}

/** Writes the render's tables beside its `qa.json` and returns the path written. */
export function writeOccupancy(qaJsonPath: string, stage: Stage, tables: readonly OccupancyTable[]): string {
  const file = OccupancyFileSchema.parse({ schema: "occupancy/v1", stage, tables });
  const path = occupancyPathFor(qaJsonPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

export function readOccupancy(path: string): OccupancyFile {
  return OccupancyFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
