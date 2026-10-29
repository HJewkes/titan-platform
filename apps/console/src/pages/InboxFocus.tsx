import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Alert, Badge, BadgeText, Typography, VStack } from "@titan-design/react-ui";

/**
 * `#/inbox/<item id>` focuses one item: a link sent to a phone lands on that row, scrolled into view and marked, rather
 * than on a list the owner has to search (TP-4389). The id is the one `inbox.list` returns, such as `gate:<run>/<step>`,
 * `deposit:<hex>` or `round:<id>`.
 */
const InboxFocusContext = createContext<string | undefined>(undefined);

export const InboxFocusProvider = InboxFocusContext.Provider;

export const useIsFocused = (itemId: string): boolean => useContext(InboxFocusContext) === itemId;

/** Whether the linked item is one of `items`, so a section holding it opens without a tap. */
export const holdsFocus = (items: readonly { id: string }[], focusId: string | undefined): boolean => focusId !== undefined && items.some((item) => item.id === focusId);

/** Wraps a row; the linked one scrolls to the middle of the screen when it first draws. */
export function FocusTarget({ itemId, children }: { itemId: string; children: ReactNode }): ReactNode {
  const focused = useIsFocused(itemId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // jsdom lays nothing out, so it has no scrollIntoView.
    if (focused && typeof ref.current?.scrollIntoView === "function") ref.current.scrollIntoView({ block: "center" });
  }, [focused]);
  return focused ? <div ref={ref} data-inbox-focus={itemId}>{children}</div> : children;
}

export function FocusBadge(): ReactNode {
  return (
    <Badge color="primary" variant="solid" size="sm" testID="inbox-focus-badge">
      <BadgeText>Linked</BadgeText>
    </Badge>
  );
}

/** A link outlives its item: once answered or withdrawn it leaves the list, and the page says so rather than showing the list as if nothing were asked. */
export function FocusNotice({ items, focusId, gapped }: { items: readonly { id: string }[]; focusId: string | undefined; gapped: boolean }): ReactNode {
  if (focusId === undefined || holdsFocus(items, focusId)) return null;
  const why = gapped ? "it was answered or withdrawn, or its source is unreadable right now" : "it was answered or withdrawn";
  return (
    <VStack gap={1} testID="inbox-focus-missing">
      <Alert status="info" message={`This item is no longer open: ${why}.`} />
      <Typography variant="caption" color="secondary" className="break-all">{focusId}</Typography>
    </VStack>
  );
}
