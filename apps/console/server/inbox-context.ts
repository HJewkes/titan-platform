import { z } from "zod";
import type { OwnerItem } from "@titan-design/owner-queue";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readFlow } from "./approvals.js";
import type { InboxReadCache } from "./inbox-rows.js";
import type { InboxSources } from "./inbox-view.js";
import { readCommand } from "./owner-guard.js";

type Recommendation = NonNullable<OwnerItem["recommended"]>;
const contextResult = z.object({
  itemId: z.string(),
  context: z.string(),
  rationale: z.string().optional(),
  cite: z.custom<Recommendation["cite"]>().optional(),
});
type InboxContext = z.infer<typeof contextResult>;

/** The one place a row's dropped context and recommendation rationale are read back, through the list's own kept needs read. */
async function readInboxContext(sources: InboxSources, cache: InboxReadCache, itemId: string): Promise<InboxContext> {
  const { flow } = await readFlow({ ...sources, factory: cache.factory });
  const item = flow.order.find((each) => each.id === itemId && each.status === "open");
  if (item === undefined) throw failure(`No open inbox item "${itemId}"`, EXIT.NOINPUT);
  const { rationale, cite } = item.recommended ?? {};
  return { itemId, context: item.context, ...(rationale !== undefined && { rationale }), ...(cite !== undefined && { cite }) };
}

export function inboxContextCommand(sources: InboxSources, cache: InboxReadCache) {
  return readCommand({
    name: "inbox.context",
    description: "One open inbox item's full context and, when it carries a recommendation, that recommendation's rationale and cite; inbox.list leaves them out of every row. An id that is not open fails as no input",
    args: z.object({ itemId: z.string().describe("the item's id, as inbox.list gives it") }),
    result: contextResult,
    run: (args) => readInboxContext(sources, cache, args.itemId),
  });
}
