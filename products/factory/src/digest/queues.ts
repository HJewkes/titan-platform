import type { OwnerItem } from "@titan-design/owner-queue";
import { digestKeys } from "../needs/morning-items.js";
import { createMorningSource } from "../needs/morning-source.js";
import type { Ask } from "./model.js";

export { morningQueueItems, queueAsk } from "../needs/morning-items.js";

/** The Ask a Morning item was built from: `context` holds its full text and the digest keys lead its keys. */
function askOfMorningItem(item: OwnerItem): Ask {
  return { text: item.context, ...(item.command !== undefined && { command: item.command }), source: item.seat ?? "", keys: digestKeys(item.keys) };
}

/** Reads through the Morning QueueSource; a seat with no queue file asks nothing. */
export async function readQueueAsks(queuesDir: string, seats: readonly string[]): Promise<Ask[]> {
  return (await createMorningSource({ dir: queuesDir, seats }).open()).map(askOfMorningItem);
}
