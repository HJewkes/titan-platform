import type { ReactNode } from "react";
import { Card, CardContent, HStack, Pill, RefChip, Select, Typography, VStack, type PillTone } from "@titan-design/react-ui";
import type { BoardLoop, LoopStatus } from "../../server/loop-board.js";
import { href } from "../router.js";
import { isStale, TIER_ROWS, tierKeyOf, type TierKey } from "./loop-tiers.js";

const STATUS_TONE: Record<LoopStatus, PillTone> = {
  ACTIVE: "info",
  STALLED: "warning",
  LOST: "error",
  MISSING: "brand-secondary",
  DONE: "success",
};

const TIER_OPTIONS = TIER_ROWS.map(({ key, label }) => ({ value: key, label: key === "unsorted" ? label : `Tier ${label}` }));

interface LoopCardProps {
  loop: BoardLoop;
  /** Null when tiers are read-only for this viewer. */
  onMove: ((to: TierKey) => void) | null;
}

/** One loop: what it is, how it is moving, and the Move to menu that is the phone's and keyboard's way to re-tier it. */
export function LoopCard({ loop, onMove }: LoopCardProps): ReactNode {
  return (
    <Card variant="outline" testID={`loop-card-${loop.id}`} className="h-full">
      <CardContent>
        <VStack gap={3}>
          <Typography variant="subtitle1" className="break-words">{loop.title}</Typography>
          <LoopVitals loop={loop} />
          <LoopRefs loop={loop} />
          {loop.doneWhen ? <Typography variant="body2" color="secondary">{`Done when: ${loop.doneWhen}`}</Typography> : null}
          {loop.blockers.ownerGated.map((gate) => (
            <Typography key={gate} variant="body2" color="warning">{`Waiting on owner: ${gate}`}</Typography>
          ))}
          <Select
            accessibilityLabel={`Move ${loop.title}`}
            value={tierKeyOf(loop.tier)}
            options={TIER_OPTIONS}
            isDisabled={onMove === null}
            onChange={(to) => (to !== null && to !== tierKeyOf(loop.tier) ? onMove?.(to) : undefined)}
            testID={`loop-move-${loop.id}`}
          />
        </VStack>
      </CardContent>
    </Card>
  );
}

function LoopVitals({ loop }: { loop: BoardLoop }): ReactNode {
  const days = loop.daysSinceMotion;
  return (
    <HStack gap={2} align="center" wrap>
      <Pill tone={STATUS_TONE[loop.status]} leading="dot" size="sm">{loop.status}</Pill>
      {days !== null ? (
        <Pill tone={isStale(loop) ? "error" : "neutral"} variant="subtle" size="sm" testID={`loop-motion-${loop.id}`}>{`${days}d since motion`}</Pill>
      ) : null}
      {loop.emphasis ? <Pill tone="neutral" variant="subtle" size="sm">{`★ ${loop.emphasis.score} · ${loop.emphasis.distinctDays}d raised`}</Pill> : null}
      {loop.source !== "ledger" ? <Pill tone="neutral" variant="outline" size="sm">{`from ${loop.source}`}</Pill> : null}
    </HStack>
  );
}

function LoopRefs({ loop }: { loop: BoardLoop }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <RefChip kind="initiative" id={`initiative:${loop.initiative}`} label={loop.initiative} href={href({ view: "initiatives", id: loop.initiative })} />
      {loop.ownerSeat ? (
        <RefChip kind="agent" id={`agent:${loop.ownerSeat}`} label={loop.ownerSeat} href={href({ view: "agents", id: loop.ownerSeat })} />
      ) : (
        <Typography variant="caption" color="secondary">no seat</Typography>
      )}
      {loop.tasks.ids.map((id) => (
        <RefChip key={id} kind="task" id={`task:${id}`} label={id} href={href({ view: "tasks", id })} testID={`loop-task-${loop.id}-${id}`} />
      ))}
      {loop.prsOpen.map((pr) => (
        <RefChip key={pr} kind="pr" id={`pr:${pr}`} label={pr} />
      ))}
    </HStack>
  );
}
