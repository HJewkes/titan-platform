import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Section, SectionContent, SectionHeader, Spinner, VStack } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import type { InboxItem } from "./InboxPage.js";
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
  return renderRows(planning.data.items.filter((item) => item.section === "planning"));
}
