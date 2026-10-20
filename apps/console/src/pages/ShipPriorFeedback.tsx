import type { ReactNode } from "react";
import { Alert, Card, CardContent, Checkbox, Typography, VStack } from "@titan-design/react-ui";
import type { PriorFeedback } from "../../server/ship-blockers.js";

interface ShipPriorFeedbackProps {
  items: readonly PriorFeedback[];
  addressed: readonly number[];
  onToggle: (round: number, checked: boolean) => void;
}

/** The owner's earlier feedback on this unit, each to be ticked Addressed before Ship is offered. */
export function ShipPriorFeedback({ items, addressed, onToggle }: ShipPriorFeedbackProps): ReactNode {
  if (items.length === 0) return null;
  return (
    <VStack gap={3} testID="ship-prior-feedback">
      {items.map((item) => (
        <Card key={`${item.round}-${item.submittedAt}`} variant="outline">
          <CardContent>
            <VStack gap={2}>
              <Typography variant="subtitle2">{`Your feedback from round ${item.round}`}</Typography>
              <PriorLine label="Your answer" text={item.revisionRequested ? "Request a revision" : item.pick} />
              <PriorLine label="Your comment" text={item.comment} />
              <PriorLine label="Your feedback on that round" text={item.general} />
              <Checkbox
                label="Addressed"
                accessibilityLabel={`Round ${item.round} feedback addressed`}
                isChecked={addressed.includes(item.round)}
                aria-checked={addressed.includes(item.round)}
                onCheckedChange={(checked) => onToggle(item.round, checked)}
              />
            </VStack>
          </CardContent>
        </Card>
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

/** Why Ship is off, spelled out beside it; Send back stays open. */
export function ShipBlockedReason({ reasons }: { reasons: readonly string[] }): ReactNode {
  if (reasons.length === 0) return null;
  const message = `Ship is off: ${reasons.join("; ")}. Send back stays open.`;
  return <Alert status="warning" size="compact" message={message} testID="ship-blocked" />;
}
