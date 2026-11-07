import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../context.js";
import { readdressCommand } from "./readdress-command.js";
import { refollowGates, type RefollowReport } from "./refollow.js";
import { coded } from "./register-args.js";

const refollowCommand = defineCommand<{ repo?: string; dryRun?: boolean }, RefollowReport, FactoryContext>({
  name: "shepherd.refollow",
  description: "cancel each pending land gate at the PR's open head whose run holds an owner merge on an earlier land gate, so the run asks again and its approval carry decides; a head is refollowed once, an owner-held run never (TP-4812)",
  args: z.object({ repo: z.string().optional(), dryRun: z.boolean().optional() }),
  result: z.custom<RefollowReport>(),
  run: async ({ repo, dryRun }, ctx) => {
    if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
    return refollowGates(ctx.host, ctx.shepherd, { dryRun, repo });
  },
});

/** The verbs that cancel a pending gate so its run asks the question again at the same head. */
export const REASK_COMMANDS = { "shepherd.readdress-dead-ends": readdressCommand, "shepherd.refollow": refollowCommand } as const;
