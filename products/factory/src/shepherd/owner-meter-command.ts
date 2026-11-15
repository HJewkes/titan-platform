import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../context.js";
import { weekBounds } from "../owner-gates/audit-sample.js";
import { coded } from "./register-args.js";
import { readAllGates } from "./owner-friction-read.js";
import { ownerMeter, type OwnerMeter } from "./owner-meter.js";

const OwnerMeterArgs = z.object({ week: z.string().describe("ISO week, such as 2026-W45") });

export const ownerMeterCommand = defineCommand<z.infer<typeof OwnerMeterArgs>, OwnerMeter, FactoryContext>({
  name: "shepherd.ownerMeter",
  description: "For one ISO week: Shepherd merges, merged runs that held an owner-resolved gate, their share, and owner resolves by owner-terminal and owner-remote; reads only",
  args: OwnerMeterArgs,
  result: z.custom<OwnerMeter>(),
  run: async ({ week }, ctx) => {
    try {
      weekBounds(week);
    } catch (error) {
      throw coded(error instanceof Error ? error.message : String(error), EXIT.USAGE);
    }
    return ownerMeter(ctx.host.runs.listByWorkflow("shepherd-pr", ["completed"]), readAllGates(ctx.host.db), week);
  },
});
