import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Tab, TabList, Tabs, VStack } from "@titan-design/react-ui";
import type { ShipBlockerTarget } from "../../server/ship-blockers.js";
import { PHONE_TAP } from "./phone.js";

/**
 * A PR's page splits into tabs (decision 167, the harness's pr-tabs.ts): Review asks the questions, Diff shows main
 * beside head, Context shows the PR. The Ship bar sits under all three. Every panel stays mounted, so a draft, a
 * scroll position or a loaded image survives a tab change and a blocker's link can always find what it names.
 */
const PR_TABS = [
  { key: "review", label: "Review" },
  { key: "diff", label: "Diff" },
  { key: "context", label: "Context" },
] as const;

/** The element id a blocker's link scrolls to; the page puts it on the question, Addressed tick, frame or round note. */
export function shipTargetId(target: ShipBlockerTarget): string {
  if (target.kind === "question") return `ship-question-${target.id}`;
  if (target.kind === "prior") return `ship-prior-${target.pr ?? "round"}-${target.round}`;
  return target.kind === "frame" ? `ship-frame-${target.key}` : "ship-general";
}

/** Outside a `PrTabs`, a jump only scrolls: nothing there is in a hidden tab. */
const ShipJump = createContext<(id: string) => void>((id) => focusTarget(document.getElementById(id)));

export const useShipJump = (): ((id: string) => void) => useContext(ShipJump);

/** A round note target focuses its field, so the owner can clear it at once; any other focuses the block itself. */
function focusTarget(element: HTMLElement | null): void {
  if (element === null) return;
  if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
  const field = element.dataset.focusField === undefined ? null : element.querySelector<HTMLElement>("textarea, input");
  (field ?? element).focus();
}

/** Wraps what a blocker can name, so its link can scroll to it and focus it. */
export function ShipTarget({ target, children }: { target: ShipBlockerTarget; children: ReactNode }): ReactNode {
  return (
    <div id={shipTargetId(target)} tabIndex={-1} className="outline-none" {...(target.kind === "general" && { "data-focus-field": "" })}>
      {children}
    </div>
  );
}

interface PrTabsProps {
  pr: string;
  review: ReactNode;
  diff: ReactNode;
  context: ReactNode;
  /** The Ship bar, under every tab. */
  bar: ReactNode;
}

/** The open tab, and a jump that opens the tab holding an element before it focuses it. */
function useTabJump() {
  const [tab, setTab] = useState(0);
  const [pending, setPending] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  // Focus waits for the render that shows the target's tab: a hidden element takes no focus.
  useEffect(() => {
    if (pending === undefined) return;
    focusTarget(document.getElementById(pending));
    setPending(undefined);
  }, [pending, tab]);
  const jump = useCallback((id: string) => {
    const panel = document.getElementById(id)?.closest<HTMLElement>("[data-pr-tab]");
    const index = panel && root.current?.contains(panel) ? PR_TABS.findIndex((each) => each.key === panel.dataset.prTab) : -1;
    if (index >= 0) setTab(index);
    setPending(id);
  }, []);
  return { tab, setTab, jump, root };
}

export function PrTabs({ pr, review, diff, context, bar }: PrTabsProps): ReactNode {
  const { tab, setTab, jump, root } = useTabJump();
  const bodies = { review, diff, context };
  return (
    <ShipJump.Provider value={jump}>
      <div ref={root} data-testid={`pr-tabs-${pr}`}>
        <VStack gap={4}>
          <Tabs index={tab} onChange={setTab}>
            <TabList>
              {PR_TABS.map((each) => <Tab key={each.key} className={PHONE_TAP}>{each.label}</Tab>)}
            </TabList>
          </Tabs>
          {PR_TABS.map((each, index) => (
            <div key={each.key} role="tabpanel" aria-label={each.label} data-pr-tab={each.key} hidden={tab !== index} data-testid={`pr-tab-${each.key}`}>
              <VStack gap={4}>{bodies[each.key]}</VStack>
            </div>
          ))}
          {bar}
        </VStack>
      </div>
    </ShipJump.Provider>
  );
}
