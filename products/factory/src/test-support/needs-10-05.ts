import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerItem, QueueSource } from "@titan-design/owner-queue";
import { decisionTaskItem } from "../needs/active-work-source.js";
import { toOwnerItem } from "../needs/agent-chat-item.js";
import { createMorningSource } from "../needs/morning-source.js";
import { GATE_COUNT, SEATS, TASK_COUNT, decisionTask, gateItem, seatQueueFile } from "./owner-queue-10-05.js";
import { brokerSnapshot } from "./owner-queue.js";

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

function staticSource(system: QueueSource["system"], items: OwnerItem[]): QueueSource {
  return {
    system,
    open: async () => items,
    tail: () => (async function* () {})(),
    resolve: async () => ({ ok: false, reason: "rejected" }),
  };
}

export function failingSource(system: QueueSource["system"], message: string): QueueSource {
  return { ...staticSource(system, []), open: async () => Promise.reject(new Error(message)) };
}

/** The four adapters over the synthetic 10-05 snapshot plus the broker snapshot; `tasks` replaces the needs-decision list. */
export async function sources10_05(tasks: OwnerItem[] = range(TASK_COUNT).map((n) => decisionTaskItem(decisionTask(n), false))): Promise<QueueSource[]> {
  const dir = mkdtempSync(join(tmpdir(), "needs-10-05-"));
  try {
    for (const seat of SEATS) writeFileSync(join(dir, `${seat}.md`), seatQueueFile(seat));
    const morning = await createMorningSource({ dir }).open();
    return [
      staticSource("agent-chat", brokerSnapshot().map(toOwnerItem)),
      staticSource("hitl", range(GATE_COUNT).map(gateItem)),
      staticSource("morning", morning),
      staticSource("active-work", tasks),
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
