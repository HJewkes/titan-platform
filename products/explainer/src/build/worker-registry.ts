import { agentChatRepairer } from "./agent-chat-repairer.js";
import type { BEAT_WORKER_IDS } from "./beat-worker.js";
import { claudePrintWorker } from "./claude-print-worker.js";

/**
 * Every runner a custom layer is built or repaired by: a one-shot claude-print call, and an agent-chat agent for the
 * repair round. No fork runner and no resumed session, whose spend would carry a parent's.
 */
export const BEAT_WORKERS = {
  "claude-print": claudePrintWorker,
  "agent-chat": agentChatRepairer,
} as const satisfies Record<(typeof BEAT_WORKER_IDS)[number], unknown>;
