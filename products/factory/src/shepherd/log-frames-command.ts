// TP-6777: `shepherd.log-frames`, one shipped PR's pr-visual before and after pairs written for the console's Decisions
// and ships log. Like the round read it informs only: no tier or merge guard reads what it writes.
import { isAbsolute, sep } from "node:path";
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../context.js";
import { writePrVisuals, type PrVisuals } from "./pr-visual-round.js";
import { RepoArg, coded } from "./register-args.js";

const SHA = /^[0-9a-f]{40}$/;

const Args = z.object({
  repo: RepoArg,
  pr: z.number().int().positive(),
  head: z.string().regex(SHA, "head must be a full commit sha"),
  dir: z.string().refine(isAbsolute, "dir must be an absolute directory path"),
});
type LogFramesArgs = z.infer<typeof Args>;

/** The caller names the folder, so it may only name a `log-frames/<owner>/<repo>/<pr>` folder for this PR; GitHub names fold case. */
const isLogFramesDir = ({ repo, pr, dir }: LogFramesArgs): boolean => dir.split(sep).slice(-4).join("/").toLowerCase() === `log-frames/${repo}/${pr}`.toLowerCase();

export const logFramesCommand = defineCommand<LogFramesArgs, PrVisuals, FactoryContext>({
  name: "shepherd.log-frames",
  description:
    "Write one PR's pr-visual before and after pairs for its head into dir (ending log-frames/<owner>/<repo>/<pr>), changed shots only, with the packet line, or the reason none are written; failed marks a read worth trying again",
  args: Args,
  result: z.custom<PrVisuals>(),
  run: async (args) => {
    if (!isLogFramesDir(args)) throw coded("dir must end in log-frames/<owner>/<repo>/<pr> for this PR", EXIT.USAGE);
    return writePrVisuals({ repo: args.repo, pr: args.pr, head: args.head }, args.dir);
  },
});
