import path from "node:path";
import { z } from "zod";

/** The internal verb a release answers with its own smoke check: `self-update --smoke <release> <sha>`. */
export const SMOKE_FLAG = "--smoke";
/** What a console bin from before the verb exits with on any argument list it does not know. */
const USAGE_EXIT = 64;
const TAIL_LINES = 20;
/** Small enough that the tail still fits inside the owner-queue item's context after the lead sentence. */
const TAIL_CHARS = 1000;

export interface NodeRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SmokePorts {
  /** Runs `node <script> ...args` with this updater's node, to completion or its timeout. */
  runNode: (script: string, args: readonly string[]) => Promise<NodeRun>;
  /** This updater's own smoke check, for a release that has no smoke verb. */
  smoke: (release: string, sha: string) => Promise<string | undefined>;
  log: (line: string) => void;
}

export const releaseCli = (release: string): string => path.join(release, "apps/console/dist/cli.js");

/** The last lines of a child's output, capped in characters from the end; empty when it wrote nothing. */
function outputTail(text: string): string {
  const lines = text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
}

export const withTail = (why: string, stderr: string): string => {
  const tail = outputTail(stderr);
  return tail === "" ? why : `${why}; its stderr ended: ${tail}`;
};

const verdictSchema = z.union([z.object({ smoke: z.literal("passed") }), z.object({ smoke: z.literal("failed"), why: z.string() })]);

export const verdictLine = (why: string | undefined): string => JSON.stringify(why === undefined ? { smoke: "passed" } : { smoke: "failed", why });

/** The verdict on the last stdout line; undefined when the runner printed none. */
function readVerdict(stdout: string): { why: string | undefined } | undefined {
  try {
    const parsed = verdictSchema.safeParse(JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? ""));
    if (!parsed.success) return undefined;
    return { why: parsed.data.smoke === "failed" ? parsed.data.why : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Runs the smoke check the new release ships, so a fix to the check deploys with the build it lands in
 * (TP-3938). A release from before the verb answers with its usage; only that falls back to this updater's check.
 */
export async function smokeFromRelease(ports: SmokePorts, release: string, sha: string): Promise<string | undefined> {
  const run = await ports.runNode(releaseCli(release), ["self-update", SMOKE_FLAG, release, sha]);
  if (run.timedOut) return withTail("the new build's smoke check did not finish in time", run.stderr);
  const verdict = readVerdict(run.stdout);
  if (verdict !== undefined) return verdict.why;
  if (run.code === USAGE_EXIT) {
    ports.log(`the build at ${release} has no self-update ${SMOKE_FLAG}; smoking it with this updater's check`);
    return ports.smoke(release, sha);
  }
  return withTail(`the new build's smoke check exited ${run.code} with no verdict`, run.stderr);
}
