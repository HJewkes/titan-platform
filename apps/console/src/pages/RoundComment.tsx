import type { ReactNode } from "react";
import { Alert, Input, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";

interface RoundCommentProps {
  question: Question;
  value: string;
  onChange: (text: string) => void;
  /** Present once the round is sent: the comment feedback.json holds, shown read-only in place of the box. */
  sent?: string;
  /** The answer asks for a revision, so the comment saying what to change is required (G10). */
  revising?: boolean;
}

/** A question's free-text comment, sent with its picks or on its own; a revision request needs one before it sends. */
export function RoundComment({ question, value, onChange, sent, revising = false }: RoundCommentProps): ReactNode {
  if (sent !== undefined) return <SentComment questionId={question.id} text={sent} />;
  return (
    <VStack gap={2}>
      {revising && value.trim() === "" ? (
        <Alert status="warning" size="compact" message="Say what to change: a revision request needs a comment before the round can send." testID={`round-comment-required-${question.id}`} />
      ) : null}
      <Input multiline numberOfLines={2} label={revising ? "Comment (required)" : "Comment (optional)"} accessibilityLabel={`Comment on ${question.prompt}`} value={value} onChangeText={onChange} />
    </VStack>
  );
}

interface RoundGeneralProps {
  value: string;
  onChange: (text: string) => void;
}

/** The round-level feedback box, sent as `general`. */
export function RoundGeneral({ value, onChange }: RoundGeneralProps): ReactNode {
  return <Input multiline numberOfLines={3} label="Feedback on this round (optional)" accessibilityLabel="Feedback on this round" value={value} onChangeText={onChange} />;
}

/** A sent question's comment, read-only. */
export function SentComment({ questionId, text }: { questionId: string; text: string | undefined }): ReactNode {
  return <SentText label="Your comment" text={text ?? ""} testID={`round-comment-sent-${questionId}`} />;
}

/** A sent Ship decision's pick as feedback.json holds it, read-only; the outcome above says what the factory did with it. */
export function SentPick({ questionId, pick }: { questionId: string; pick: string | undefined }): ReactNode {
  return <SentText label="Your answer" text={pick ?? ""} testID={`round-pick-sent-${questionId}`} />;
}

/** A sent round's `general` text, read-only. */
export function SentGeneral({ text }: { text: string | undefined }): ReactNode {
  return <SentText label="Your feedback on this round" text={text ?? ""} testID="round-general-sent" />;
}

function SentText({ label, text, testID }: { label: string; text: string; testID: string }): ReactNode {
  if (text.trim() === "") return null;
  return (
    <VStack gap={1} testID={testID}>
      <Typography variant="microLabel" color="secondary">{label.toUpperCase()}</Typography>
      <Typography variant="body2">{text}</Typography>
    </VStack>
  );
}
