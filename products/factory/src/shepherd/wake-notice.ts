import type { AgentRow } from "@titan-design/agent-dispatch";
import { failureOf } from "./error-class.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { lineageSeat, newestAgent } from "./wake-roster.js";

/** What a wake no agent took told the session that spawned its lineage, which can start the fix round by hand. */
export type SpawnerNotice = { sent: boolean; detail: string; seat?: string };

/** The wake the notice names, and the lineage whose spawner it goes to. */
interface NoticedWake {
  input: { repo: string; pr: number; headSha: string; kind: string };
  pr: { headRef: string };
  implementer: string;
  successors: readonly string[];
}

function noticeText(wake: NoticedWake, reason: string, newest: string | undefined): string {
  const { input, pr } = wake;
  return [
    `Shepherd: ${input.repo}#${input.pr} at head ${input.headSha}: no agent took the ${input.kind} wake, so nothing is fixing it: ${reason}.`,
    `Next: resume ${newest ?? wake.implementer} with the failure, start a successor on branch ${pr.headRef}, or push a fix yourself. The run waits for a new head.`,
  ].join("\n");
}

/**
 * A wake no agent took leaves the run waiting on a head nobody is pushing, so the lineage's spawner is told why. It runs
 * inside the wake step, so a replay reads the record and sends nothing. Throws only on abort; a lineage only the human
 * spawned, or a failed read or send, is recorded as not sent.
 */
export async function noticeSpawner(ports: ExitNoticePorts, roster: () => Promise<readonly AgentRow[]>, wake: NoticedWake, reason: string, signal: AbortSignal): Promise<SpawnerNotice> {
  try {
    const rows = await roster();
    const seat = lineageSeat(wake, rows);
    if (seat === undefined) return { sent: false, detail: "no session spawned the lineage" };
    await ports.send(seat, noticeText(wake, reason, newestAgent(wake, rows)?.name));
    return { sent: true, seat, detail: `told ${seat}` };
  } catch (error) {
    signal.throwIfAborted();
    return { sent: false, detail: `the spawner notice failed: ${failureOf(error)}` };
  }
}

