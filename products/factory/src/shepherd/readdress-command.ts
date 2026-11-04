import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../context.js";
import { readdressDeadEnds, type ReaddressReport } from "./readdress.js";
import { coded } from "./register-args.js";

export const readdressCommand = defineCommand<{ apply?: boolean }, ReaddressReport, FactoryContext>({
  name: "shepherd.readdress-dead-ends",
  description: "TP-4759's one-shot move of pending dead-end owner gates (a fixer's exit with no push, shepherd-route fix-first-runaway or failed-rounds) to the seat that registered the PR; without apply it only lists each gate and its addressee",
  args: z.object({ apply: z.boolean().optional() }),
  result: z.custom<ReaddressReport>(),
  run: async ({ apply }, ctx) => {
    if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
    return readdressDeadEnds(ctx.host, ctx.shepherd, { apply });
  },
});
