import type { ReactNode } from "react";
import { Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { FrameFigure } from "./FrameFeedback.js";
import { RoundAudio } from "./AudioPlayer.js";
import { RoundClip } from "./ClipPlayer.js";
import { frameAnchor, useFrameMedia, useFrameSource, type ABSide } from "./QuestionFrames.js";
import { OptionNote, OptionTexts, type OptionNoting } from "./OptionCard.js";
import { FrameImage } from "./RoundFrame.js";
import { InlineMarkdown, plainText } from "./RoundMarkdown.js";
import type { QuestionAnswer } from "./RoundQuestion.js";
import { playsMedia } from "./TrueSize.js";

/** What a page that answers A/B questions holds for one: a note per option, and the "Neither" request. */
export interface ABAnswering extends OptionNoting {
  onNeither: () => void;
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
 * A required pick-one without its own `revisionOption` offers the built-in revision request, as the server's feedback
 * writer accepts it (G10). Feedback@1 has no "neither" or "both" field, so on an A/B neither is that request, and
 * "both" is whatever further option the round lists.
 */
export const offersBuiltInRevision = (question: Question): boolean => question.kind === "pick-one" && question.required === true && question.revisionOption === undefined;

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
    </VStack>
  );
}

interface ABColumnProps extends QuestionABProps {
  side: ABSide;
  name: string;
  picked: boolean;
}

/** In a design round a side's frame takes a verdict too, which picking the side marks Chosen. */
function ABColumn({ question, side, name, picked, notes, onNote, onChoose, sent }: ABColumnProps): ReactNode {
  const source = useFrameSource();
  const media = useFrameMedia();
  const detail = question.kind === "pick-one" ? question.optionDetails?.[side.option] : undefined;
  return (
    <FrameFigure frameKey={side.key} label={side.label} pinnable={(source?.loadable(side.key) ?? false) && !playsMedia(media(side.key))} id={frameAnchor(question.id, side.key)} testID={`question-ab-side-${question.id}-${name}`}>
      <HStack gap={2} align="center" justify="between" wrap>
        <Typography variant="subtitle2">{`${name}: `}<InlineMarkdown text={side.option} /></Typography>
        <Typography variant="caption" color="secondary">{`frame: ${side.label}`}</Typography>
      </HStack>
      <SideFrame side={side} />
      <Button variant={picked ? "solid" : "outline"} color="primary" aria-pressed={picked} onPress={() => onChoose(side.option)}>
        <ButtonText>{picked ? `Picked ${name}` : keyed(side.index, `Pick ${name}`)}</ButtonText>
      </Button>
      {detail ? <OptionTexts option={side.option} detail={detail} /> : null}
      <OptionNote option={side.option} label={`Note on ${name} (optional)`} notes={notes} onNote={onNote} sent={sent} />
    </FrameFigure>
  );
}

function SideFrame({ side }: { side: ABSide }): ReactNode {
  const source = useFrameSource();
  const media = useFrameMedia()(side.key);
  if (source !== null && media?.clip !== undefined) return <RoundClip roundId={source.roundId} frameKey={side.key} alt={side.label} motion={media.motion} />;
  if (source !== null && media?.audio !== undefined) return <RoundAudio roundId={source.roundId} frameKey={side.key} alt={side.label} transcript={media.transcript} durationMs={media.durationMs} />;
  if (source === null || !source.loadable(side.key)) return <Typography variant="caption" color="secondary">No image for this frame</Typography>;
  return <FrameImage roundId={source.roundId} frameKey={side.key} view="head" alt={side.label} />;
}

/** The options that are not a side, such as "Both", and the built-in "Neither" where the question offers it. */
function OtherAnswers({ question, sides, answer, onChoose, onNeither, revising }: QuestionABProps & { revising: boolean }): ReactNode {
  const sideOptions = new Set(sides.map((side) => side.option));
  const others = question.kind === "pick-one" ? question.options.map((option, index) => ({ option, index })).filter(({ option }) => !sideOptions.has(option)) : [];
  if (others.length === 0 && !offersBuiltInRevision(question)) return null;
  return (
    <HStack gap={2} align="center" wrap>
      {others.map(({ option, index }) => (
        <Button key={option} variant={pickedIn(answer) === option ? "solid" : "outline"} size="sm" aria-pressed={pickedIn(answer) === option} onPress={() => onChoose(option)}>
          <ButtonText>{keyed(index, plainText(option))}</ButtonText>
        </Button>
      ))}
      {offersBuiltInRevision(question) ? (
        <Button variant={revising ? "solid" : "outline"} color="warning" size="sm" aria-pressed={revising} onPress={onNeither}>
          <ButtonText>Neither: request a revision</ButtonText>
        </Button>
      ) : null}
    </HStack>
  );
}
