import { useEffect, type ReactNode } from "react";
import { Accordion, AccordionButton, AccordionItem, AccordionPanel, Link, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../server/commands.js";
import { useInvalidate, useQuery } from "./data/rpc.js";

type BannerItem = ConsoleCommands["blockers.banner"]["result"]["items"][number];

/** An item ages past the threshold while the tab sits open, and nothing relays a clock tick. */
const REFRESH_MS = 5 * 60_000;

interface BlockerClass {
  key: string;
  label: string;
  includes: (item: BannerItem) => boolean;
}

const CLASSES: readonly BlockerClass[] = [
  { key: "inbox", label: "Inbox blockers", includes: (item) => item.source === "blocker" },
  { key: "shepherd", label: "Shepherd waits", includes: (item) => item.source !== "blocker" },
];

/** A failed or empty read shows nothing; `StaleLine` already covers a dead stream. */
export function BlockerBanner(): ReactNode {
  const invalidate = useInvalidate();
  useEffect(() => {
    const timer = setInterval(() => invalidate(["blockers.banner"]), REFRESH_MS);
    return () => clearInterval(timer);
  }, [invalidate]);
  const banner = useQuery("blockers.banner");
  if (banner.data === undefined || banner.data.count === 0) return null;
  const { items, count } = banner.data;
  // The RPC lists only the oldest few, so a class count from them is a floor once the total is larger.
  const truncated = count > items.length;
  return (
    <div className="px-gutter-sm pt-gutter-sm sm:px-gutter-md sm:pt-gutter-md" data-testid="blocker-banner">
      <VStack gap={1}>
        {CLASSES.map((each) => (
          <ClassLine key={each.key} blockerClass={each} items={items.filter(each.includes)} truncated={truncated} />
        ))}
      </VStack>
    </div>
  );
}

function ClassLine({ blockerClass, items, truncated }: { blockerClass: BlockerClass; items: readonly BannerItem[]; truncated: boolean }): ReactNode {
  const oldest = items[0];
  if (oldest === undefined) return null;
  const count = `${items.length}${truncated ? "+" : ""}`;
  return (
    <Accordion>
      <AccordionItem>
        <AccordionButton>
          <span className="block min-w-0 max-w-full truncate whitespace-nowrap" data-testid={`blocker-line-${blockerClass.key}`}>
            {`${blockerClass.label}: ${count} · oldest ${oldest.ageHours} h`}
          </span>
        </AccordionButton>
        <AccordionPanel>
          <VStack gap={1}>
            {items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </VStack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

function ItemRow({ item }: { item: BannerItem }): ReactNode {
  return (
    <Link color="primary" href={item.link} testID={`blocker-item-${item.id}`}>
      <Typography variant="body2">{`${item.summary} (${item.ageHours} h, blocks ${item.blocks})`}</Typography>
    </Link>
  );
}
