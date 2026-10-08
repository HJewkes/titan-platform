import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { GitHubPort } from "@titan-design/github";
import { landGate } from "./coordinator-evidence.js";
import { EXIT } from "./exit-codes.js";
import type { BatchOutcome } from "./gate-batch-store.js";
import { digestOf, formatPlan, planBatch, type BatchItem } from "./gate-batch-plan.js";
import { pendingGateId, resolveGate, type OwnerPresence } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { confirmOwner } from "./owner-presence.js";

interface BatchIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

export interface BatchDeps {
  presence: OwnerPresence;
  /** Fresh PR reads; without one, only the gate store says whether an item moved or closed. */
  port?: Pick<GitHubPort, "getPr">;
}

interface Skip {
  outcome: Extract<BatchOutcome, `skipped-${string}`>;
  detail: string;
}

/**
 * `titan-factory gate resolve-batch`: shows an itemized list of merge gates, asks for owner presence once, records the
 * signed batch, then answers `merge` to each gate through `gate resolve` only while it is still pending at the listed
 * head. A bad list or a denied presence check resolves nothing; a failed resolve stops the batch with the record kept.
 */
export async function resolveBatch(host: FactoryHost, io: BatchIo, source: string, deps: Partial<BatchDeps> = {}): Promise<number> {
  const items = planBatch(host, source);
  if (typeof items === "string") {
    io.stderr(`error: ${items}; nothing was resolved\n`);
    return EXIT.USAGE;
  }
  const digest = digestOf(items);
  io.stdout(formatPlan(items, digest));
  const proof = await (deps.presence ?? confirmOwner)(`resolve ${items.length} merge gates as batch ${digest.slice(0, 16)}`);
  if (proof === undefined) {
    io.stderr("error: owner presence was not confirmed; nothing was resolved\n");
    return EXIT.FAILURE;
  }
  const batchId = randomUUID();
  host.batches.open({ id: batchId, digest, proof, signedBy: userInfo().username }, items);
  io.stdout(`signed batch ${batchId}\n`);
  return fireAll(host, io, { batchId, proof, port: deps.port }, items);
}

interface Signed {
  batchId: string;
  proof: string;
  port?: Pick<GitHubPort, "getPr">;
}

async function fireAll(host: FactoryHost, io: BatchIo, signed: Signed, items: readonly BatchItem[]): Promise<number> {
  const counts = { resolved: 0, skipped: 0 };
  for (const [seq, item] of items.entries()) {
    const skip = await staleness(host, item, signed.port);
    if (skip) {
      host.batches.mark(signed.batchId, seq, skip.outcome, skip.detail);
      io.stdout(`skipped ${item.gate}: ${skip.outcome.slice("skipped-".length)} (${skip.detail})\n`);
      counts.skipped += 1;
      continue;
    }
    if (!(await fireOne(host, io, signed, seq, item))) {
      io.stderr(`error: batch ${signed.batchId} stopped at item ${seq + 1}; the items after it were not resolved\n`);
      return EXIT.FAILURE;
    }
    counts.resolved += 1;
  }
  io.stdout(`batch ${signed.batchId}: ${counts.resolved} resolved, ${counts.skipped} skipped\n`);
  return EXIT.OK;
}

/** Marks the item `firing` first, so a process that dies inside the resolve leaves that item named in the record. */
async function fireOne(host: FactoryHost, io: BatchIo, signed: Signed, seq: number, item: BatchItem): Promise<boolean> {
  host.batches.mark(signed.batchId, seq, "firing");
  let said = "";
  const quiet = { stdout: () => undefined, stderr: (text: string) => void (said += text), env: io.env };
  const payload = JSON.stringify({ decision: "merge", headSha: item.headSha });
  const code = await resolveGate(host, quiet, item.runId, item.stepId, payload, async () => signed.proof).catch((error: unknown) => ((said += String(error instanceof Error ? error.message : error)), EXIT.FAILURE));
  if (code !== EXIT.OK) {
    const detail = said.trim() || `gate resolve exited ${code}`;
    host.batches.mark(signed.batchId, seq, "failed", detail);
    io.stderr(`failed ${item.gate}: ${detail}\n`);
    return false;
  }
  host.batches.mark(signed.batchId, seq, "resolved");
  io.stdout(`resolved ${item.gate} at ${item.headSha}\n`);
  return true;
}

/** Why the item must not fire now, read just before it would: its gate closed or moved, or its PR did on GitHub. */
async function staleness(host: FactoryHost, item: BatchItem, port: Signed["port"]): Promise<Skip | undefined> {
  const gate = host.gates.get(item.gate);
  if (gate?.status !== "pending") return { outcome: "skipped-closed", detail: `the gate is ${gate?.status ?? "gone"}` };
  const waiting = pendingGateId(host, item.runId, item.stepId);
  if (waiting !== item.gate) return { outcome: "skipped-moved", detail: `the run waits on ${waiting ?? "no gate"} now` };
  const head = landGate(gate)?.head;
  if (head !== item.headSha) return { outcome: "skipped-moved", detail: `the gate asks about head ${head ?? "unknown"}` };
  return port ? pullStaleness(port, item) : undefined;
}

async function pullStaleness(port: NonNullable<Signed["port"]>, item: BatchItem): Promise<Skip | undefined> {
  const ref = `${item.repo}#${item.pr}`;
  try {
    const pull = await port.getPr(item.repo, item.pr);
    if (pull.state !== "open") return { outcome: "skipped-closed", detail: `${ref} is ${pull.merged ? "merged" : "closed"} on GitHub` };
    if (pull.headSha !== item.headSha) return { outcome: "skipped-moved", detail: `${ref} is at head ${pull.headSha} on GitHub` };
    return undefined;
  } catch (error) {
    return { outcome: "skipped-unreadable", detail: `${ref} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
