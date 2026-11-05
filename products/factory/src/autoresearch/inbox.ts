import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ProposalSchema, type ArPorts, type Proposal } from "@titan-design/autoresearch";

/** Run ids name files here, so one that could climb out of the inbox dir is refused before any path is built. */
function inboxFile(inboxDir: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith(".")) throw new Error(`[inbox-run] ${runId} is not a run id`);
  return join(inboxDir, `${runId}.jsonl`);
}

/** One owner proposal, checked and flushed to disk before the CLI reports it queued. */
export function appendOwnerIdea(inboxDir: string, runId: string, proposal: unknown): Proposal {
  const parsed = ProposalSchema.parse(proposal);
  mkdirSync(inboxDir, { recursive: true });
  const fd = openSync(inboxFile(inboxDir, runId), "a");
  try {
    writeSync(fd, `${JSON.stringify(parsed)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return parsed;
}

/** The engine records each read, so a replayed round sees the ideas it saw then, however many lines came after. */
export function ownerIdeasPort(inboxDir: string): NonNullable<ArPorts["ownerIdeas"]> {
  return async ({ runId, after }) => {
    const file = inboxFile(inboxDir, runId);
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    return { ideas: lines.slice(after).map((line) => ProposalSchema.parse(JSON.parse(line))), cursor: lines.length };
  };
}
