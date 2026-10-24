import { z } from "zod";

/** A merged PR serves a lane goal, is a side quest (upkeep, flakes, red main), or is neither. */
export const LANE_ROLES = ["goal", "side-quest", "other"] as const;
export type LaneRole = (typeof LANE_ROLES)[number];

const DigestItemSchema = z.object({
  // Stable across runs: derived from the source (repo and PR number, commit sha, task id), never a timestamp.
  id: z.string().min(1),
  /** `rollup` is derived from the other items: a lane, goal, ship or day total the script cites. */
  kind: z.enum(["commit", "pull-request", "task", "session", "rollup"]),
  title: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
  repo: z.string().min(1).optional(),
  url: z.url().optional(),
  summary: z.string().optional(),
  /** What happened to the item that day: a PR `opened` or `merged`, a task `opened`, `closed`, `moved` or `owner-gated`. */
  change: z.string().min(1).optional(),
  /** A merged PR's head branch, which names the seat that did the work. */
  branch: z.string().min(1).optional(),
  /** What a merged PR did, in a sentence: the first prose sentence of its body, else its title. */
  outcome: z.string().min(1).optional(),
  /** Top-two path segments of the files a merged PR changed, changesets left out. */
  packages: z.array(z.string().min(1)).optional(),
  /** Lines added plus lines deleted. */
  size: z.number().int().nonnegative().optional(),
  /** `P1` makes the item an anchor the audition must place. */
  priority: z.string().min(1).optional(),
  /** The lane a merged PR or rollup belongs to, its role there, and the lane goal it served. */
  lane: z.string().min(1).optional(),
  role: z.enum(LANE_ROLES).optional(),
  goal: z.string().min(1).optional(),
});

export type DigestItem = z.infer<typeof DigestItemSchema>;

/** `digest.json`: what happened in a window, the gather step's output and the plan step's input. */
export const DigestSchema = z
  .object({
    since: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }),
    items: z.array(DigestItemSchema),
  })
  .superRefine((digest, ctx) => {
    if (Date.parse(digest.until) < Date.parse(digest.since)) {
      ctx.addIssue({ code: "custom", path: ["until"], message: "until precedes since" });
    }
    const seen = new Set<string>();
    digest.items.forEach((item, i) => {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: ["items", i, "id"], message: `duplicate id ${item.id}` });
      seen.add(item.id);
    });
  });

export type Digest = z.infer<typeof DigestSchema>;
