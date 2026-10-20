import type { ReactNode } from "react";
import { Button, ButtonText, HStack, Input, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { frameAnchor, useFrameSource, type ABSide } from "./QuestionFrames.js";
import { FrameImage } from "./RoundFrame.js";
import { InlineMarkdown, plainText } from "./RoundMarkdown.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

/** What a page that answers A/B questions holds for one: a note per option, and the "Neither" request. */
export interface ABAnswering {
  notes: Readonly<Record<string, string>>;
  onNote: (option: string, text: string) => void;
  onNeither: () => void;
  /** The round is sent: each note box gives way to the note as sent. */
  sent?: boolean;
}

interface QuestionABProps extends ABAnswering {
  question: Question;
  sides: readonly [ABSide, ABSide];
  answer: QuestionAnswer | undefined;
  onChoose: (choice: string) => void;
}

const MAX_KEYED = 9;

const keyed = (index: number, text: string): string => (index < MAX_KEYED ? `${index + 1}  ${text}` : text);
const pickedIn = (answer: QuestionAnswer | undefined): string | undefined => (answer && "pick" in answer ? answer.pick : undefined);

/**
 * Feedback@1 has no "neither" or "both" field, so neither is the built-in revision request a required pick-one
 * without its own revision option already offers, and "both" is whatever further option the round lists.
 */
const offersNeither = (question: Question): boolean => question.kind === "pick-one" && question.required === true && question.revisionOption === undefined;

/** Two options side by side, each with its frame, its pick and a note; stacked on a phone. */
export function QuestionAB(props: QuestionABProps): ReactNode {
  const { question, sides, answer } = props;
  const revising = answer !== undefined && "revisionRequested" in answer;
  return (
    <VStack gap={3}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid={`question-ab-${question.id}`}>
        {sides.map((side, at) => (
          <ABColumn key={side.option} {...props} side={side} name={at === 0 ? "A" : "B"} picked={pickedIn(answer) === side.option} />
        ))}
      </div>
      <OtherAnswers {...props} revising={revising} />
      {revising ? <Typography variant="caption" color="secondary">Neither: say what to change in the comment below; the round sends once it has one.</Typography> : null}
    </VStack>
  );
}

interface ABColumnProps extends QuestionABProps {
  side: ABSide;
  name: string;
  picked: boolean;
}

function ABColumn({ question, side, name, picked, notes, onNote, onChoose, sent }: ABColumnProps): ReactNode {
  return (
    <figure id={frameAnchor(question.id, side.key)} className="flex min-w-0 flex-col gap-2" data-testid={`question-ab-side-${question.id}-${name}`}>
      <HStack gap={2} align="center" justify="between" wrap>
        <Typography variant="subtitle2">{`${name}: `}<InlineMarkdown text={side.option} /></Typography>
        <Typography variant="caption" color="secondary">{`frame: ${side.label}`}</Typography>
      </HStack>
      <SideFrame side={side} />
      <Button variant={picked ? "solid" : "outline"} color="primary" aria-pressed={picked} onPress={() => onChoose(side.option)}>
        <ButtonText>{picked ? `Picked ${name}` : keyed(side.index, `Pick ${name}`)}</ButtonText>
      </Button>
      {sent ? (
        <SentNote option={side.option} note={notes[side.option]} />
      ) : (
        <Input multiline numberOfLines={2} label={`Note on ${name} (optional)`} accessibilityLabel={`Note on ${side.option}`} value={notes[side.option] ?? ""} onChangeText={(text) => onNote(side.option, text)} />
      )}
    </figure>
  );
}

/** An option note as sent, read-only. */
function SentNote({ option, note }: { option: string; note: string | undefined }): ReactNode {
  if (!note?.trim()) return null;
  return (
    <VStack gap={1} testID={`question-ab-note-sent-${option}`}>
      <Typography variant="microLabel" color="secondary">YOUR NOTE</Typography>
      <Typography variant="body2">{note}</Typography>
    </VStack>
  );
}

function SideFrame({ side }: { side: ABSide }): ReactNode {
  const source = useFrameSource();
  if (source === null || !source.loadable(side.key)) return <Typography variant="caption" color="secondary">No image for this frame</Typography>;
  return <FrameImage roundId={source.roundId} frameKey={side.key} view="head" alt={side.label} />;
}

/** The options that are not a side, such as "Both", and the built-in "Neither" where the question offers it. */
function OtherAnswers({ question, sides, answer, onChoose, onNeither, revising }: QuestionABProps & { revising: boolean }): ReactNode {
  const sideOptions = new Set(sides.map((side) => side.option));
  const others = question.kind === "pick-one" ? question.options.map((option, index) => ({ option, index })).filter(({ option }) => !sideOptions.has(option)) : [];
  if (others.length === 0 && !offersNeither(question)) return null;
  return (
    <HStack gap={2} align="center" wrap>
      {others.map(({ option, index }) => (
        <Button key={option} variant={pickedIn(answer) === option ? "solid" : "outline"} size="sm" aria-pressed={pickedIn(answer) === option} onPress={() => onChoose(option)}>
          <ButtonText>{keyed(index, plainText(option))}</ButtonText>
        </Button>
      ))}
      {offersNeither(question) ? (
        <Button variant={revising ? "solid" : "outline"} color="warning" size="sm" aria-pressed={revising} onPress={onNeither}>
          <ButtonText>Neither: request a revision</ButtonText>
        </Button>
      ) : null}
    </HStack>
  );
}
