import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";

const LaneGoalSchema = z.object({ id: z.string().min(1), line: z.string().min(1), tags: z.array(z.string().min(1)).min(1) }).strict();

const LaneSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    /** Seat prefixes of `agent-chat/<seat>-…` branches: who did the work, which decides the lane first. */
    seats: z.array(z.string().min(1)).default([]),
    /** Repos (`owner/name`) the lane owns whole, read when the branch names no seat. */
    repos: z.array(z.string().min(1)).default([]),
    /** Path prefixes of a PR's packages (`products/x`), read when neither seat nor repo decides. */
    paths: z.array(z.string().min(1)).default([]),
    goals: z.array(LaneGoalSchema).default([]),
  })
  .strict();
export type Lane = z.infer<typeof LaneSchema>;

/** Thread order keys, applied in the file's order; a later key breaks a tie of the earlier ones. */
export const RANK_KEYS = ["role", "closed", "estimate", "severity", "prs", "size"] as const;
export type RankKey = (typeof RANK_KEYS)[number];

export const LanesFileSchema = z
  .object({
    schema: z.literal("daily-lanes/v1"),
    /** The lane a PR takes when nothing else claims it. */
    fallback: z.string().min(1),
    /** Task tags that make a PR a side quest, whatever goal its other tags meet. */
    sideQuestTags: z.array(z.string().min(1)),
    rank: z.array(z.enum(RANK_KEYS)).min(1),
    /** Named threads per lane: `clamp(round(laneSeconds / secondsPerThread), min, max)`. */
    named: z
      .object({
        lanesBlockS: z.number().positive(),
        laneFloorS: z.number().nonnegative(),
        secondsPerThread: z.number().positive(),
        min: z.number().int().nonnegative(),
        max: z.number().int().positive(),
      })
      .strict(),
    ships: z.object({ count: z.number().int().nonnegative(), perLane: z.number().int().positive() }).strict(),
    lanes: z.array(LaneSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set(file.lanes.map((lane) => lane.id));
    if (ids.size !== file.lanes.length) ctx.addIssue({ code: "custom", path: ["lanes"], message: "duplicate lane id" });
    if (!ids.has(file.fallback)) ctx.addIssue({ code: "custom", path: ["fallback"], message: `fallback ${file.fallback} is not a lane` });
    if (file.named.min > file.named.max) ctx.addIssue({ code: "custom", path: ["named"], message: "min exceeds max" });
  });
export type LanesFile = z.infer<typeof LanesFileSchema>;

export const DEFAULT_LANES_FILE = join(DEFAULT_DOCTRINE_DIR, "daily", "lanes.yaml");

export function loadLanes(file: string = DEFAULT_LANES_FILE): LanesFile {
  return LanesFileSchema.parse(parse(readFileSync(file, "utf8")));
}

/** The host's `daily/lanes.yaml` under `home` when it keeps one, which holds the live goals; else the doctrine default. */
export function lanesFileFor(home: string): string {
  const host = join(home, "daily", "lanes.yaml");
  return existsSync(host) ? host : DEFAULT_LANES_FILE;
}
