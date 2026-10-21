import type { ReactNode } from "react";
import { Badge, HStack, Radio, RadioGroup, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question } from "../../server/round-schema.js";
import { answerBlockers, shipStake, type DraftAnswer } from "../../server/ship-blockers.js";

const quoted = (options: readonly string[]): string => options.map((option) => `"${option}"`).join(" or ");

/** What would block Ship on this question, before anything is answered (TP-3345). */
function stakeLine(manifest: Manifest, question: Question): string {
  const stake = shipStake(manifest, question);
  if (stake.kind === "picks" && stake.blocking.length > 0) return `Picking ${quoted(stake.blocking)}, or leaving a comment, blocks Ship and sends the PR back to the fixer.`;
  if (stake.kind === "set") return `Any picks but exactly ${stake.expected.join(", ")}, or a comment, block Ship and send the PR back to the fixer.`;
  return "Your answer is informational and never blocks Ship; only a comment does.";
}

function StakeBadge({ blocks, answered, followUp }: { blocks: boolean; answered: boolean; followUp: boolean }): ReactNode {
  if (followUp) return <Badge color="info" size="sm">Follow-up</Badge>;
  if (blocks) return <Badge color="warning" size="sm">Blocks Ship</Badge>;
  return answered ? <Badge variant="subtle" size="sm">Won't block Ship</Badge> : null;
}

interface ShipStakeProps {
  manifest: Manifest;
  question: Question;
  /** The answer as it would be sent; undefined while the question is untouched. */
  answer: DraftAnswer | undefined;
  followUp: boolean;
  onFollowUp: (followUp: boolean) => void;
}

/** A side question's stake in Ship: what blocks it, whether the answer now does, and the This PR or Follow-up choice (TP-3346). */
export function ShipStake({ manifest, question, answer, followUp, onFollowUp }: ShipStakeProps): ReactNode {
  const blocks = answer !== undefined && answerBlockers(manifest, answer).length > 0;
  return (
    <VStack gap={2} testID={`ship-stake-${question.id}`}>
      <HStack gap={2} align="center" wrap>
        <StakeBadge blocks={blocks} answered={answer !== undefined} followUp={followUp} />
        <Typography variant="caption" color="secondary">
          {followUp ? "Follow-up: never blocks Ship. Your answer is filed in the inbox as a follow-up when you send." : stakeLine(manifest, question)}
        </Typography>
      </HStack>
      <RadioGroup value={followUp ? "follow-up" : "this-pr"} onChange={(value) => onFollowUp(value === "follow-up")} orientation="horizontal" label="This answer is for">
        <Radio value="this-pr" aria-checked={!followUp}>This PR</Radio>
        <Radio value="follow-up" aria-checked={followUp}>Follow-up</Radio>
      </RadioGroup>
    </VStack>
  );
}

/** A sent question filed as a follow-up, read-only. */
export function SentFollowUp({ questionId }: { questionId: string }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap testID={`ship-follow-up-sent-${questionId}`}>
      <Badge color="info" size="sm">Follow-up</Badge>
      <Typography variant="caption" color="secondary">Marked follow-up, so it did not block Ship.</Typography>
    </HStack>
  );
}
