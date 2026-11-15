import type { ReactNode } from "react";
import { HStack, Link, Typography, VStack } from "@titan-design/react-ui";
import { open, parseRoute } from "../router.js";
import type { InboxItem } from "./InboxPage.js";
import { PHONE_TAP_ID_LINK } from "./phone.js";

type Provenanced = Pick<InboxItem, "asker" | "seat" | "initiative" | "unblocksNow" | "blocker">;

/** Who asked, for which initiative, and what the answer frees; each shows only when the item carries it. */
export function RowProvenance({ item }: { item: Provenanced }): ReactNode {
  const asker = item.asker ?? item.seat;
  if (asker === undefined && item.initiative === undefined && item.unblocksNow === undefined && item.blocker === undefined) return null;
  return (
    <VStack gap={1}>
      {asker !== undefined || item.initiative !== undefined ? (
        <HStack gap={2} align="center" wrap>
          {asker !== undefined ? <Typography variant="caption" color="secondary">{`Asked by ${asker}`}</Typography> : null}
          {item.initiative !== undefined ? <InitiativeLink slug={item.initiative} /> : null}
        </HStack>
      ) : null}
      {item.unblocksNow !== undefined ? <Typography variant="caption">{`Unblocks now: ${item.unblocksNow}`}</Typography> : null}
      {item.blocker !== undefined ? <Typography variant="caption" color="secondary">{`Blocks: ${item.blocker.blocks}`}</Typography> : null}
    </VStack>
  );
}

function InitiativeLink({ slug }: { slug: string }): ReactNode {
  return (
    <Link color="primary" className={PHONE_TAP_ID_LINK} onPress={() => open(parseRoute(`#/initiatives/${encodeURIComponent(slug)}`))}>
      {slug}
    </Link>
  );
}
