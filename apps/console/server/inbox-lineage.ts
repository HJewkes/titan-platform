import type { InboxItem } from "./inbox-view.js";
import { UNWIRED_LINEAGE, type LineageReader } from "./ship-lineage.js";

/** Unwired or unread, a merge gate still carries a lineage, so its row says "lineage unknown" rather than showing nothing. */
export async function withLineage(items: InboxItem[], read: LineageReader | undefined): Promise<InboxItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const { action } = item;
      if (action.kind !== "resolve-gate" || action.decision !== "merge") return item;
      const lineage = read === undefined ? UNWIRED_LINEAGE : await read({ repo: action.repo, pr: action.pr, headSha: action.headSha });
      return { ...item, lineage };
    }),
  );
}
