import { useEffect, type ReactNode } from "react";
import { Alert, Card, CardContent, Checkbox, CheckboxGroup, HStack, Pill, Radio, RadioGroup, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "@titan-design/review-schema";

/** A pick is held in the page only; nothing here sends it anywhere. */
export type QuestionAnswer = { pick: string } | { picks: string[] } | { value: number };

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

interface RoundQuestionProps {
  question: Question;
  /** The question's place in the round, shown as Q<n>. */
  position: number;
  answer: QuestionAnswer | undefined;
  onChoose: (choice: string) => void;
  /** The active question is the one digit keys answer; pressing the card or one of its options activates it. */
  active: boolean;
  onActivate: () => void;
}

/** One round@2 question with its options and any recommendation the server sent; reusable outside #/rounds. */
export function RoundQuestion({ question, position, answer, onChoose, active, onActivate }: RoundQuestionProps): ReactNode {
  // A pressed option does not reach the card's own press handler, so choosing activates the question too.
  const choose = (choice: string): void => {
    onActivate();
    onChoose(choice);
  };
  return (
    <Card variant={active ? "outline" : "subtle"} onPress={onActivate} testID={`round-question-${question.id}`}>
      <CardContent>
        <VStack gap={3}>
          <QuestionHeading question={question} position={position} active={active} />
          <Choices question={question} answer={answer} onChoose={choose} />
          <QuestionFacts question={question} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function QuestionHeading({ question, position, active }: { question: Question; position: number; active: boolean }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <Typography variant="monoLabel" color="secondary">{`Q${position}`}</Typography>
      <Typography variant="subtitle1">{question.prompt}</Typography>
      {question.required ? <Pill variant="subtle" size="xs">required</Pill> : null}
      {active && choicesOf(question).length > 0 ? <Typography variant="caption" color="secondary">keys 1-9 answer</Typography> : null}
    </HStack>
  );
}

/** A keyed choice carries its digit, so the label says which key picks it. */
const choiceLabel = (index: number, choice: string): string => (index < MAX_KEYED_CHOICES ? `${index + 1}  ${choice}` : choice);

function Choices({ question, answer, onChoose }: { question: Question; answer: QuestionAnswer | undefined; onChoose: (choice: string) => void }): ReactNode {
  const choices = choicesOf(question);
  if (question.kind === "text") return <Typography variant="caption" color="secondary">Text answer</Typography>;
  if (question.kind === "pick-many") {
    const picks = answer && "picks" in answer ? answer.picks : [];
    return (
      <CheckboxGroup label="Pick any">
        {choices.map((choice, index) => (
          <Checkbox key={choice} value={choice} label={choiceLabel(index, choice)} isChecked={picks.includes(choice)} aria-checked={picks.includes(choice)} onCheckedChange={() => onChoose(choice)} />
        ))}
      </CheckboxGroup>
    );
  }
  const value = answer && "pick" in answer ? answer.pick : answer && "value" in answer ? String(answer.value) : null;
  return (
    <RadioGroup value={value} onChange={onChoose} orientation={question.kind === "scale" ? "horizontal" : "vertical"} label={question.kind === "scale" ? `${question.min} to ${question.max}` : "Pick one"}>
      {choices.map((choice, index) => (
        <Radio key={choice} value={choice} aria-checked={value === choice}>
          {choiceLabel(index, choice)}
        </Radio>
      ))}
    </RadioGroup>
  );
}

const answerText = (answer: string | number | readonly string[]): string => (Array.isArray(answer) ? answer.join(", ") : String(answer));

function QuestionFacts({ question }: { question: Question }): ReactNode {
  const recommendation = question.kind === "text" ? undefined : question.recommendation;
  const merge = question.kind === "pick-one" ? question.merge : undefined;
  const signsOff = question.kind === "pick-one" ? question.signsOff : undefined;
  return (
    <VStack gap={1}>
      {signsOff ? <Typography variant="caption" color="secondary">{`Signs off: ${signsOff}`}</Typography> : null}
      {merge ? <Typography variant="caption" color="secondary">{`Ships ${merge.repo}#${merge.pr} at ${merge.headSha.slice(0, 7)}`}</Typography> : null}
      {recommendation ? (
        <Alert status="info" size="compact" message={`Recommended: ${answerText(recommendation.answer)} (${Math.round(recommendation.confidence * 100)}%, ${recommendation.by})`}>
          <Typography variant="caption" color="secondary">{recommendation.rationale}</Typography>
        </Alert>
      ) : null}
    </VStack>
  );
}
