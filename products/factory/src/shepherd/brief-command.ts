import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { activeWorkDocTasks } from "../doc/task-source.js";
import type { FactoryContext } from "../registry.js";
import { readBriefFacts } from "./brief-inputs.js";
import { BRIEF_FORMATS, renderBrief, type BriefOutput, type RenderPorts } from "./brief-render.js";
import { activeWorkOrigin } from "./cleanup-ports.js";
import { PrArg, RepoArg, coded } from "./register-args.js";

const BriefArgs = z.object({ repo: RepoArg, pr: PrArg, format: z.enum(BRIEF_FORMATS).default("md"), images: z.string().min(1).optional() });
type BriefArgs = z.infer<typeof BriefArgs>;

/** Tasks come from the services' reader when the host binds one, else from the active-work daemon at its loopback origin. */
function portsOf(ctx: FactoryContext): RenderPorts {
  const bound = ctx.shepherd?.tasks;
  const live = activeWorkDocTasks({ origin: activeWorkOrigin(process.env) });
  return { readTask: bound ?? ((slug, id) => live.read(slug, id)), now: ctx.shepherd?.now ?? Date.now };
}

async function brief({ repo, pr, format, images }: BriefArgs, ctx: FactoryContext): Promise<BriefOutput> {
  if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  const facts = await readBriefFacts(ctx.host, ctx.shepherd, { repo, pr });
  return renderBrief(facts, { format, ...(images !== undefined && { images }) }, portsOf(ctx));
}

export const briefCommand = defineCommand<BriefArgs, BriefOutput, FactoryContext>({
  name: "shepherd.brief",
  description: "Print the owner PR section for owner/repo#pr from GitHub, the run's pending approve-merge gate, its latest verdict and owner brief, and the task; md or round-section JSON, with before and after pairs from --images. Reads only",
  args: BriefArgs,
  result: z.custom<BriefOutput>(),
  run: brief,
});
