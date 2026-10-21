import type { ReactNode } from "react";
import { Alert, Card, CardContent, Checkbox, Link, Typography, VStack } from "@titan-design/react-ui";
import { isAddressed, type AddressedTick, type PriorFeedback, type ShipBlocker } from "../../server/ship-blockers.js";
import { ShipTarget, shipTargetId, useShipJump } from "./ShipTabs.js";

/** An earlier round's entries that bear on `pr`: its own, and those on no PR in particular (TP-3790). */
export const priorFor = (items: readonly PriorFeedback[], pr: string): PriorFeedback[] => items.filter((item) => item.pr === undefined || item.pr === pr);

interface ShipPriorFeedbackProps {
  items: readonly PriorFeedback[];
  /** The PR whose tab shows these cards, so a blocker on that tab scrolls to its own card. */
  pr: string;
  /** A tick naming another PR leaves this PR's card open (TP-3885). */
  addressed: readonly AddressedTick[];
  onToggle: (item: PriorFeedback, checked: boolean) => void;
  /** Sent or sending: the ticks show as sent and take no more presses. */
  locked?: boolean;
}

/** The owner's earlier feedback on this unit, each to be ticked Addressed before Ship is offered. */
export function ShipPriorFeedback({ items, pr, addressed, onToggle, locked = false }: ShipPriorFeedbackProps): ReactNode {
  if (items.length === 0) return null;
  return (
    <VStack gap={3} testID="ship-prior-feedback">
      {items.map((item) => (
        <ShipTarget key={`${item.pr ?? ""}-${item.round}-${item.submittedAt}`} target={{ kind: "prior", round: item.round, pr }}>
          <Card variant="outline">
            <CardContent>
              <VStack gap={2}>
                <Typography variant="subtitle2">{`Your feedback from round ${item.round}`}</Typography>
                <PriorLine label="Your answer" text={item.revisionRequested ? "Request a revision" : item.pick} />
                <PriorLine label="Your comment" text={item.comment} />
                <PriorLine label="Your feedback on that round" text={item.general} />
                <PriorFrames lines={item.frames} />
                <Checkbox
                  label="Addressed"
                  accessibilityLabel={`Round ${item.round} feedback addressed`}
                  isChecked={isAddressed(addressed, item)}
                  aria-checked={isAddressed(addressed, item)}
                  isDisabled={locked}
                  onCheckedChange={(checked) => (locked ? undefined : onToggle(item, checked))}
                />
              </VStack>
            </CardContent>
          </Card>
        </ShipTarget>
      ))}
    </VStack>
  );
}

function PriorLine({ label, text }: { label: string; text: string | undefined }): ReactNode {
  if (text === undefined) return null;
  return (
    <VStack gap={1}>
      <Typography variant="microLabel" color="secondary">{label.toUpperCase()}</Typography>
      <Typography variant="body2">{text}</Typography>
    </VStack>
  );
}

/** Each frame that round judged, one line apiece: its label, verdict, comment and pins. */
function PriorFrames({ lines }: { lines: readonly string[] | undefined }): ReactNode {
  if (lines === undefined) return null;
  return (
    <VStack gap={1}>
      <Typography variant="microLabel" color="secondary">YOUR FRAME FEEDBACK</Typography>
      {lines.map((line) => <Typography key={line} variant="body2">{line}</Typography>)}
    </VStack>
  );
}

/** Why Ship is off, one link per reason that scrolls to what it names and focuses it; Send back stays open. */
export function ShipBlockedReason({ reasons }: { reasons: readonly ShipBlocker[] }): ReactNode {
  const jump = useShipJump();
  if (reasons.length === 0) return null;
  return (
    <VStack gap={1} testID="ship-blocked">
      <Alert status="warning" size="compact" message="Ship is off until you clear these; Send back stays open." />
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {reasons.map((reason) => (
          <li key={`${shipTargetId(reason.target)}-${reason.message}`}>
            <Link color="primary" onPress={() => jump(shipTargetId(reason.target))}>{reason.message}</Link>
          </li>
        ))}
      </ul>
    </VStack>
  );
}
