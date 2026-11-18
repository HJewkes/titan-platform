import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Section, SectionContent, SectionHeader, VStack } from "@titan-design/react-ui";
import { Spinner } from "../shell/Loading.js";
import { useQuery } from "../data/rpc.js";
import { holdsFocus, useFocusId } from "./InboxFocus.js";
import { badgeOf, type InboxItem } from "./InboxPage.js";
import { PHONE_TAP } from "./phone.js";

/** `inbox.list` lists the planning items only when asked; the default read counts them (TP-4390). */
export const PLANNING_READ = { planning: true };

interface PlanningProps {
  count: number;
  startOpen: boolean;
  renderRows: (items: readonly InboxItem[]) => ReactNode;
}

/** Planning can run to hundreds of rows, so it opens only when asked, or when a link names one of them; only then are its rows read. */
export function PlanningSection({ count, startOpen, renderRows }: PlanningProps): ReactNode {
  const [isOpen, setOpen] = useState(startOpen);
  return (
    <Section testID="inbox-planning">
      <SectionHeader title={`Planning (${count})`} subtitle="Answered at each item's source" />
      <SectionContent>
        <VStack gap={3}>
          <Button variant="outline" size="sm" className={PHONE_TAP} onPress={() => setOpen(!isOpen)}>
            <ButtonText>{isOpen ? "Hide planning" : `Show ${count} planning items`}</ButtonText>
          </Button>
          {isOpen ? <PlanningRows renderRows={renderRows} /> : null}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function PlanningRows({ renderRows }: Pick<PlanningProps, "renderRows">): ReactNode {
  const planning = useQuery("inbox.list", PLANNING_READ);
  if (planning.status === "loading") return <Spinner size="sm" label="Loading the planning items" />;
  if (planning.data === undefined) return <Alert status="error" message={`Could not load the planning items: ${planning.error.message}`} />;
  const groups = groupByAsker(planning.data.items.filter((item) => item.section === "planning"));
  if (groups.length === 1) return renderRows(groups[0]!.items);
  return (
    <VStack gap={3}>
      {groups.map((group) => <PlanningGroup key={group.name} group={group} renderRows={renderRows} />)}
    </VStack>
  );
}

interface AskerGroup {
  name: string;
  items: InboxItem[];
}

/** Largest group first; equal groups keep the order the server listed them in. */
function groupByAsker(items: readonly InboxItem[]): AskerGroup[] {
  const byName = new Map<string, AskerGroup>();
  for (const item of items) {
    const name = item.asker ?? item.seat ?? badgeOf(item).label;
    const group = byName.get(name) ?? { name, items: [] };
    group.items.push(item);
    byName.set(name, group);
  }
  return [...byName.values()].sort((a, b) => b.items.length - a.items.length);
}

function PlanningGroup({ group, renderRows }: Pick<PlanningProps, "renderRows"> & { group: AskerGroup }): ReactNode {
  const focusId = useFocusId();
  const [isOpen, setOpen] = useState(holdsFocus(group.items, focusId));
  return (
    <VStack gap={2}>
      <Button variant="ghost" size="sm" className={PHONE_TAP} testID={`inbox-planning-group-${group.name}`} onPress={() => setOpen(!isOpen)}>
        <ButtonText>{`${group.name} (${group.items.length})`}</ButtonText>
      </Button>
      {isOpen ? renderRows(group.items) : null}
    </VStack>
  );
}
