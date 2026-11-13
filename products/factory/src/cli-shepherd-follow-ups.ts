import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { parseFollowUps } from "@titan-design/review-panel";
import type { Command } from "commander";
import type { Verbs } from "./cli-types.js";
import { EXIT } from "./exit-codes.js";
import { errorMessage } from "./narrow.js";
import { parsePrRef } from "./registry.js";
import { activeWorkFollowUpTasks, activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { FixTaskRefused } from "./shepherd/main-red.js";
import { fileFollowUps } from "./shepherd/follow-ups-file.js";
import { HEAD } from "./shepherd/await-verdict.js";
import { qualifyTask, TaskIndexUnavailable } from "./shepherd/task-ref.js";

interface FollowUpsArgs {
  task: string;
  head: string;
  reviewer?: string;
  verdictFile?: string;
}

class UsageError extends Error {}

function targetOf(ref: string, opts: FollowUpsArgs): { repo: string; pr: number } {
  if (!HEAD.test(opts.head)) throw new UsageError("--head must be 40 lowercase hex characters");
  return parsePrRef(ref);
}

async function qualified(task: string, verbs: Verbs): Promise<{ initiative: string; parent: string }> {
  const full = await qualifyTask(task, { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) });
  const at = full.indexOf("/");
  if (at <= 0 || at === full.length - 1) throw new UsageError("--task must be <initiative>/<ID>");
  return { initiative: full.slice(0, at), parent: full.slice(at + 1) };
}

/** Files a reviewer's Follow-ups block from a verdict the seat chose; the seat is the reader, so the verb does not check the block names this PR and head. */
async function run(ref: string, opts: FollowUpsArgs, verbs: Verbs): Promise<number> {
  const { io } = verbs;
  let where: Awaited<ReturnType<typeof qualified>> & { repo: string; pr: number };
  try {
    where = { ...(await qualified(opts.task, verbs)), ...targetOf(ref, opts) };
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n`);
    return error instanceof TaskIndexUnavailable ? EXIT.UNAVAILABLE : EXIT.USAGE;
  }
  const { items, warning } = parseFollowUps(opts.verdictFile === undefined ? await text(process.stdin) : await readFile(opts.verdictFile, "utf8"));
  try {
    const tasks = activeWorkFollowUpTasks({ origin: activeWorkOrigin(io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) });
    const { filed } = await fileFollowUps(tasks, { ...where, head: opts.head, reviewer: opts.reviewer ?? "seat" }, items);
    io.stdout(`${JSON.stringify({ filed, ...(warning && { warning }) })}\n`);
    return EXIT.OK;
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n`);
    return error instanceof FixTaskRefused ? EXIT.FAILURE : EXIT.UNAVAILABLE;
  }
}

/** The seat-path twin of Shepherd's own filing: no serve needed, the verb talks to active-work directly. */
export function registerShepherdFollowUps(shepherd: Command, verbs: Verbs): void {
  shepherd
    .command("follow-ups <ref>")
    .description("file the Follow-ups block of a reviewer verdict (stdin, or --verdict-file) as open tasks linked from --task; prints { filed, warning? } as JSON")
    .requiredOption("--task <slug/id>", "the task the reviewed PR delivers")
    .requiredOption("--head <sha>", "the 40-character head the verdict reviewed")
    .option("--reviewer <name>", "the reviewer named in each filed task's notes", "seat")
    .option("--verdict-file <path>", "read the verdict from this file instead of stdin")
    .action(async (ref: string, opts: FollowUpsArgs) => verbs.setExit(await run(ref, opts, verbs)));
}
