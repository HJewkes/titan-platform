// The read-only calibration read behind `titan-factory shepherd visual-delta` (TP-4320 S6): the evidence step's visual
// delta for one PR, with no step, no write and no evidence record, so the threshold can be set from real PRs first.
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { HEAD } from "./await-verdict.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { PrArg, RepoArg, coded } from "./register-args.js";
import { readVisualDelta, type VisualDelta } from "./visual-delta-read.js";

/** The bounded decoder's refusal for a PNG outside 8-bit RGB or RGBA (png-bounded.ts), after the measure's `base: ` or `head: `. */
const UNSUPPORTED_FORMAT = ": unsupported PNG format";

const VisualDeltaArgs = z.object({ repo: RepoArg, pr: PrArg, head: z.string().regex(HEAD, "must be 40 lowercase hex characters").optional() });
type VisualDeltaArgs = z.infer<typeof VisualDeltaArgs>;

/** An alias, not an interface: the command map's declarations inline it, so it needs no export. */
type VisualDeltaReport = {
  repo: string;
  pr: number;
  head: string;
  /** Shots the decoder refused as an unsupported format; any at all means S3b's accepted set must widen before mode `on`. */
  unsupportedFormat: number;
  visualDelta: VisualDelta;
};

const unsupportedOf = ({ snapshots }: VisualDelta): number => snapshots.filter((shot) => shot.status === "unmeasured" && shot.reason?.endsWith(UNSUPPORTED_FORMAT) === true).length;

/** Measures under the repo's own threshold whatever its mode, so a repo still at `off` or `shadow` can be calibrated. */
async function readReport({ repo, pr, head }: VisualDeltaArgs, ctx: FactoryContext): Promise<VisualDeltaReport> {
  const services = ctx.shepherd;
  if (!services) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  const threshold = services.visualThreshold?.(repo);
  if (!threshold) throw coded(`${repo} has no shepherd.visualThreshold, so there are no snapshot paths to measure`, EXIT.NOINPUT);
  const read = await services.port.getPr(repo, pr);
  const at = head ?? read.headSha;
  const paths = await pinnedPaths(services.port, { repo, pr, head: at }, read.headSha);
  const visualDelta = await readVisualDelta(services.port, { repo, head: at, baseRef: read.baseRef }, paths.unread ?? paths.files, threshold);
  return { repo, pr, head: at, unsupportedFormat: unsupportedOf(visualDelta), visualDelta };
}

export const visualDeltaCommand = defineCommand<VisualDeltaArgs, VisualDeltaReport, FactoryContext>({
  name: "shepherd.visual-delta",
  description: "Measure owner/repo#pr's visual delta at its head (or --head, which must still be the PR's head) under the repo's shepherd.visualThreshold, as the merge evidence step would; runs no step and writes nothing",
  args: VisualDeltaArgs,
  result: z.custom<VisualDeltaReport>(),
  run: readReport,
});
