import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const DailySourcesSchema = z
  .object({
    schema: z.literal("daily-sources/v1"),
    repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name")),
    decisions: z.string().min(1).optional(),
  })
  .strict();

interface DailySources {
  repos: string[];
  decisions?: string;
}

/** The repos and decisions log the host keeps in `<data dir>/daily/sources.yaml`; undefined when it keeps none. */
export function loadDailySources(dataDir: string): DailySources | undefined {
  const file = join(dataDir, "daily", "sources.yaml");
  if (!existsSync(file)) return undefined;
  const { repos, decisions } = DailySourcesSchema.parse(parse(readFileSync(file, "utf8")));
  return { repos, ...(decisions === undefined ? {} : { decisions }) };
}
