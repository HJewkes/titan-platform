import { useEffect, type ReactNode } from "react";
import { Card, CardContent, Checkbox, CheckboxGroup, HStack, Input, Pill, Radio, RadioGroup, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { QuestionAB, type ABAnswering } from "./QuestionAB.js";
import { InlineMarkdown, plainText } from "./RoundMarkdown.js";
import { QuestionFrameLinks, QuestionFrames, useABSides, useOptionFrame } from "./QuestionFrames.js";
import { RecommendationBox, RevealControl, recommendedChoices, useRecommendation, useRevealTracking } from "./RoundReveal.js";

/** An answer as the page holds it; a page that submits turns it into a `rounds.submit` answer. */
export type QuestionAnswer = { pick: string } | { picks: string[] } | { value: number } | { text: string } | { revisionRequested: true };

/** Keys 1-9 reach the first nine choices; a longer list is answered by pointer. */
const MAX_KEYED_CHOICES = 9;

/** What a question offers to pick, in order: its options, or each step of its scale. */
export function choicesOf(question: Question): string[] {
  if (question.kind === "pick-one" || question.kind === "pick-many") return question.options;
  if (question.kind === "scale") return Array.from({ length: question.max - question.min + 1 }, (_, step) => String(question.min + step));
  return [];
}

/** The answer after choosing `choice`: a pick-many toggles it, every other kind replaces. */
export function chooseIn(question: Question, answer: QuestionAnswer | undefined, choice: string): QuestionAnswer {
  if (question.kind === "scale") return { value: Number(choice) };
  if (question.kind !== "pick-many") return { pick: choice };
  const picks = answer && "picks" in answer ? answer.picks : [];
  return { picks: picks.includes(choice) ? picks.filter((pick) => pick !== choice) : [...picks, choice] };
}

/** The choice digit `key` names in this question, or null. */
export function choiceForKey(question: Question, key: string): string | null {
  const digit = Number(key);
  if (!/^[1-9]$/.test(key) || digit > MAX_KEYED_CHOICES) return null;
  return choicesOf(question)[digit - 1] ?? null;
}

function typedInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Digits 1-9 choose in the active question, unless a modifier is held or the owner is typing in a field. */
export function useChoiceKeys(question: Question | undefined, onChoose: (choice: string) => void): void {
  useEffect(() => {
    if (!question) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typedInto(event.target)) return;
      const choice = choiceForKey(question, event.key);
      if (choice === null) return;
      event.preventDefault();
      onChoose(choice);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [question, onChoose]);
}

/** `r` reveals or hides the active question's recommendation, under the same guards as the digit keys. */
function useRevealKey(active: boolean, toggle: (() => void) | undefined): void {
  useEffect(() => {
    if (!active || toggle === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "r" || event.ctrlKey || event.metaKey || event.altKey || typedInto(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, toggle]);
}

interface RoundQuestionProps {
  question: Question;
  /** The question's place in the round, shown as Q<n>. */
  position: number;
  answer: QuestionAnswer | undefined;
  onChoose: (choice: string) => void;
  /** The active question is the one digit keys answer; pressing the card or one of its options activates it. */
  active: boolean;
  onActivate: () => void;
  /** Present only where the page submits text answers; without it a text question shows a placeholder. */
  onText?: (text: string) => void;
  /** Present where the page takes A/B notes; with it a pick-one whose options pick two frames lays them side by side. */
  ab?: ABAnswering;
}

/** One round@2 question with its options and any recommendation the server sent; reusable outside #/rounds. */
export function RoundQuestion({ question, position, answer, onChoose, active, onActivate, onText, ab }: RoundQuestionProps): ReactNode {
  const sides = useABSides(question);
  const shown = useRecommendation(question, answer);
  useRevealKey(active, shown.toggle);
  // A pressed option does not reach the card's own press handler, so choosing activates the question too.
  const choose = (choice: string): void => {
    onActivate();
    onChoose(choice);
  };
  return (
    <Card variant={active ? "outline" : "subtle"} onPress={onActivate} testID={`round-question-${question.id}`}>
      <CardContent>
        <VStack gap={3}>
          <QuestionFrames question={question} omit={ab && sides ? sides.map((side) => side.key) : []} />
          <QuestionHeading question={question} position={position} active={active} />
          {ab && sides ? (
            <QuestionAB question={question} sides={sides} answer={answer} onChoose={choose} {...ab} />
          ) : (
            <Choices question={question} answer={answer} onChoose={choose} onText={onText} recommended={recommendedChoices(shown)} />
          )}
          <QuestionFacts question={question} answer={answer} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function QuestionHeading({ question, position, active }: { question: Question; position: number; active: boolean }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <Typography variant="monoLabel" color="secondary">{`Q${position}`}</Typography>
      <Typography variant="subtitle1"><InlineMarkdown text={question.prompt} /></Typography>
      {question.required ? <Pill variant="subtle" size="xs">required</Pill> : null}
      {active && choicesOf(question).length > 0 ? <Typography variant="caption" color="secondary">keys 1-9 answer</Typography> : null}
    </HStack>
  );
}

/** A keyed choice carries its digit, so the label says which key picks it, and the frame it picks when it picks one. */
function choiceLabel(index: number, choice: string, frame: string | undefined): string {
  const keyed = index < MAX_KEYED_CHOICES ? `${index + 1}  ${choice}` : choice;
  return frame === undefined ? keyed : `${keyed} (frame: ${frame})`;
}

/** `choiceLabel` with the option's markdown rendered, and a badge on the option a shown recommendation picks. */
function ChoiceLabel({ index, choice, frame, recommended }: { index: number; choice: string; frame: string | undefined; recommended: boolean }): ReactNode {
  return (
    <>
      {index < MAX_KEYED_CHOICES ? `${index + 1}  ` : null}
      <InlineMarkdown text={choice} />
      {frame === undefined ? null : ` (frame: ${frame})`}
      {recommended ? <span className="ml-2 inline-flex"><Pill variant="subtle" size="xs" tone="info">Recommended</Pill></span> : null}
    </>
  );
}

interface ChoicesProps {
  question: Question;
  answer: QuestionAnswer | undefined;
  onChoose: (choice: string) => void;
  onText?: (text: string) => void;
  /** The options a shown recommendation picks, badged. */
  recommended: readonly string[];
}

function Choices({ question, answer, onChoose, onText, recommended }: ChoicesProps): ReactNode {
  const choices = choicesOf(question);
  const frameOf = useOptionFrame(question);
  if (question.kind === "text" && onText === undefined) return <Typography variant="caption" color="secondary">Text answer</Typography>;
  if (question.kind === "text") {
    const text = answer && "text" in answer ? answer.text : "";
    return <Input multiline numberOfLines={3} label="Your answer" accessibilityLabel={`Answer to ${question.prompt}`} value={text} onChangeText={onText} />;
  }
  if (question.kind === "pick-many") {
    const picks = answer && "picks" in answer ? answer.picks : [];
    return (
      <CheckboxGroup label="Pick any">
        {choices.map((choice, index) => (
          <Checkbox key={choice} value={choice} label={`${choiceLabel(index, plainText(choice), frameOf(choice))}${recommended.includes(choice) ? "  · Recommended" : ""}`} isChecked={picks.includes(choice)} aria-checked={picks.includes(choice)} onCheckedChange={() => onChoose(choice)} />
        ))}
      </CheckboxGroup>
    );
  }
  return <PickOne question={question} answer={answer} onChoose={onChoose} choices={choices} frameOf={frameOf} recommended={recommended} />;
}

interface PickOneProps extends Omit<ChoicesProps, "onText"> {
  choices: readonly string[];
  frameOf: (choice: string) => string | undefined;
}

/** A pick-one or scale as radios; a sent revision request says so, as it picks none of them. */
function PickOne({ question, answer, onChoose, choices, frameOf, recommended }: PickOneProps): ReactNode {
  const value = answer && "pick" in answer ? answer.pick : answer && "value" in answer ? String(answer.value) : null;
  return (
    <VStack gap={1}>
      {answer && "revisionRequested" in answer ? <Typography variant="caption" color="secondary">You asked for a revision instead of an option.</Typography> : null}
      <RadioGroup value={value} onChange={onChoose} orientation={question.kind === "scale" ? "horizontal" : "vertical"} label={question.kind === "scale" ? `${question.min} to ${question.max}` : "Pick one"}>
        {choices.map((choice, index) => (
          <Radio key={choice} value={choice} aria-checked={value === choice}>
            <ChoiceLabel index={index} choice={choice} frame={frameOf(choice)} recommended={recommended.includes(choice)} />
          </Radio>
        ))}
      </RadioGroup>
    </VStack>
  );
}

/** A question's sign-off, merge binding, and its recommendation: sent by the server, or revealed on demand (TP-3774). */
export function QuestionFacts({ question, answer }: { question: Question; answer?: QuestionAnswer }): ReactNode {
  const shown = useRecommendation(question, answer);
  useRevealTracking(question, answer, shown.visible);
  const merge = question.kind === "pick-one" ? question.merge : undefined;
  const signsOff = question.kind === "pick-one" ? question.signsOff : undefined;
  return (
    <VStack gap={1}>
      <QuestionFrameLinks question={question} />
      {signsOff ? <Typography variant="caption" color="secondary">{`Signs off: ${signsOff}`}</Typography> : null}
      {merge ? <Typography variant="caption" color="secondary">{`Ships ${merge.repo}#${merge.pr} at ${merge.headSha.slice(0, 7)}`}</Typography> : null}
      <RevealControl question={question} shown={shown} />
      <RecommendationBox question={question} answer={answer} shown={shown} />
    </VStack>
  );
}
