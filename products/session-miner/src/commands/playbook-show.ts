import { scoreBullet, type FeedbackEvent, type Maturity, type Provenance } from "@titan-design/memory";
import { defineCommand, EXIT } from "@titan-design/registry";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { PLAYBOOK_TABLES, requireMinerTables } from "../miner-tables.js";

export interface PlaybookShowResponse {
  id: string;
  content: string;
  category: string;
  tags: string[];
  maturity: Maturity;
  state: string;
  effectiveScore: number;
  helpfulCount: number;
  harmfulCount: number;
  sourceSessions: Provenance[];
  feedback: Array<Pick<FeedbackEvent, "type" | "at" | "sessionRef" | "reason">>;
  replacedBy: string | null;
  deprecationReason: string | null;
  /** Ids of the rules this one replaced. */
  supersededBy: string[];
}

const ShowArgs = z.object({ id: z.string().min(1) });

export const playbookShow = defineCommand<z.infer<typeof ShowArgs>, PlaybookShowResponse, MinerContext>({
  name: "playbook.show",
  description: "One rule with its source sessions, feedback log and the rules it replaced or was replaced by",
  args: ShowArgs,
  result: z.custom<PlaybookShowResponse>(),
  cli: { positional: ["id"] },
  async run(args, ctx) {
    requireMinerTables(ctx, "playbook.show", PLAYBOOK_TABLES);
    const store = ctx.playbook();
    const bullet = store.get(args.id);
    if (!bullet) throw Object.assign(new Error(`no playbook rule ${args.id}`), { code: EXIT.NOINPUT });
    const events = store.feedbackFor(args.id);
    const scored = scoreBullet(bullet, events, new Date());
    return {
      id: bullet.id,
      content: bullet.content,
      category: bullet.category,
      tags: bullet.tags,
      maturity: scored.maturity,
      state: bullet.state,
      effectiveScore: scored.effectiveScore,
      helpfulCount: scored.helpfulCount,
      harmfulCount: scored.harmfulCount,
      sourceSessions: bullet.sourceSessions,
      feedback: events.map(({ type, at, sessionRef, reason }) => ({ type, at, sessionRef, reason })),
      replacedBy: bullet.replacedBy,
      deprecationReason: bullet.deprecationReason,
      supersededBy: store.supersededBy(args.id),
    };
  },
});
