import { useState, type ReactNode } from "react";
import {
  Alert, Badge, Button, ButtonText, Card, CardContent, HStack, Input, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RoundDetail } from "../../server/rounds.js";
import type { Question } from "../../server/round-schema.js";
import { useQuery } from "../data/rpc.js";
import { useSubmit, type SubmitState } from "../data/submit.js";
import { FrameImage, type FrameView } from "./RoundFrame.js";
import { QuestionFacts, RoundQuestion, chooseIn, type QuestionAnswer } from "./RoundQuestion.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type PickOne = Extract<Question, { kind: "pick-one" }>;
type MergeQuestion = PickOne & { merge: NonNullable<PickOne["merge"]> };
type GateAnswer = ValidRound["answer"];
type ListedFrame = ConsoleCommands["rounds.frames"]["result"]["frames"][number];

interface ShipFrame {
  key: string;
  label: string;
  theme?: ListedFrame["theme"];
  views: FrameView[];
}

const isMergeQuestion = (question: Question): question is MergeQuestion => question.kind === "pick-one" && question.merge !== undefined;
const sha7 = (sha: string): string => sha.slice(0, 7);

type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/** A merge gate: each changed image as before | after | diff, then the round's questions in order, the Ship or Send back pick bound to the PR head among them. */
export function ShipRound({ round }: { round: ValidRound }): ReactNode {
  const question = round.manifest.questions.find(isMergeQuestion);
  const side = useSideAnswers();
  if (question === undefined) return null;
  return (
    <VStack gap={4}>
      <ShipHeading round={round} question={question} />
      <Montages round={round} />
      {round.manifest.questions.map((each, index) =>
        each === question ? (
          <ShipAnswer key={each.id} round={round} question={question} sideQuestions={round.manifest.questions.filter((other) => other !== question)} side={side.answers} />
        ) : (
          <SideQuestion key={each.id} question={each} position={index + 1} side={side} />
        ),
      )}
    </VStack>
  );
}

function ShipHeading({ round, question }: { round: ValidRound; question: MergeQuestion }): ReactNode {
  const section = round.manifest.sections.find((candidate) => candidate.questionIds.includes(question.id));
  return (
    <Card variant="subtle">
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle1">{question.prompt}</Typography>
          {section?.changed ? <Typography variant="caption">{`Changed: ${section.changed}`}</Typography> : null}
          <QuestionFacts question={question} />
          {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">The recommendation shows once the round is answered.</Typography> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}

function Montages({ round }: { round: ValidRound }): ReactNode {
  const listed = useQuery("rounds.frames", { id: round.id });
  if (listed.status === "loading") return <Spinner size="sm" label="Loading the round's images" />;
  if (listed.data === undefined) return <Alert status="error" message={`Could not list the round's images: ${listed.error.message}`} />;
  const byKey = new Map(listed.data.frames.map((frame) => [frame.key, frame]));
  const frames = round.manifest.variants.flatMap((variant): ShipFrame[] => {
    if (variant.image === undefined) return [];
    const frame = byKey.get(variant.key);
    return [{ key: variant.key, label: variant.label, theme: frame?.theme, views: frame?.views ?? ["head"] }];
  });
  if (frames.length === 0) return null;
  return (
    <Section>
      <SectionHeader title={`Changed images (${frames.length})`} subtitle="Before, after and diff for each image. Tap an image to enlarge it." />
      <SectionContent>
        <VStack gap={6}>
          {themePairs(frames).map((group) => (group.length === 2 ? <ThemePair key={group[0].key} roundId={round.id} pair={group} /> : <FrameMontage key={group[0].key} roundId={round.id} frame={group[0]} />))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

type FrameGroup = [ShipFrame] | [ShipFrame, ShipFrame];

const pairsWith = (last: FrameGroup | undefined, frame: ShipFrame): last is [ShipFrame] =>
  last?.length === 1 && last[0].theme !== undefined && frame.theme !== undefined && last[0].theme !== frame.theme;

/** Neighbours in opposite themes are one variant in both; round@2 0.3.0's `variantUnit` replaces this reading (TP-3232). */
function themePairs(frames: readonly ShipFrame[]): FrameGroup[] {
  const groups: FrameGroup[] = [];
  for (const frame of frames) {
    const last = groups.at(-1);
    if (pairsWith(last, frame)) groups[groups.length - 1] = [last[0], frame];
    else groups.push([frame]);
  }
  return groups;
}

function ThemePair({ roundId, pair }: { roundId: string; pair: [ShipFrame, ShipFrame] }): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2" data-testid={`theme-pair-${pair[0].key}`}>
      {pair.map((frame) => <FrameMontage key={frame.key} roundId={roundId} frame={frame} />)}
    </div>
  );
}

/** A CI packet's head is its montage, so AFTER reads the `after` image whenever the round lists one. */
function panelsOf(views: readonly FrameView[]): { label: string; view: FrameView }[] {
  const after = { label: "AFTER", view: views.includes("after") ? ("after" as const) : ("head" as const) };
  if (!views.includes("base")) return [after];
  return [{ label: "BEFORE", view: "base" }, after, ...(views.includes("diff") ? [{ label: "DIFF", view: "diff" as const }] : [])];
}

function FrameMontage({ roundId, frame }: { roundId: string; frame: ShipFrame }): ReactNode {
  const isNew = !frame.views.includes("base");
  return (
    <div className="flex flex-col gap-2" data-testid={`montage-${frame.key}`}>
      <HStack gap={2} align="center" wrap>
        <Typography variant="subtitle2">{frame.label}</Typography>
        {frame.theme ? <Pill variant="subtle" size="xs">{frame.theme}</Pill> : null}
        {isNew ? <Badge color="info" size="sm">NEW</Badge> : null}
      </HStack>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {panelsOf(frame.views).map(({ label, view }) => (
          <figure key={label} className="flex flex-col gap-1">
            <Typography variant="microLabel" color="secondary">{label}</Typography>
            <FrameImage roundId={roundId} frameKey={frame.key} view={view} alt={`${frame.label}, ${label.toLowerCase()}`} />
          </figure>
        ))}
      </div>
      {!isNew && !frame.views.includes("diff") ? <Typography variant="caption" color="secondary">No diff image: compare before and after side by side.</Typography> : null}
    </div>
  );
}

interface ShipAnswerProps {
  round: ValidRound;
  question: MergeQuestion;
  sideQuestions: readonly Question[];
  side: Record<string, QuestionAnswer>;
}

function ShipAnswer({ round, question, sideQuestions, side }: ShipAnswerProps): ReactNode {
  const { available, state, submit } = useSubmit();
  const [note, setNote] = useState("");
  if (round.status === "sent" || state.status === "sent") return <AnswerOutcome answer={round.answer} headSha={question.merge.headSha} state={state} />;
  const sendBack = question.options.find((option) => !question.merge.ship.includes(option));
  const comment = note.trim();
  const sent = { id: round.id, manifestSha256: round.manifestSha256, general: "" };
  const sideAnswers = submittedAnswers(sideQuestions, side);
  const missing = sideQuestions.filter((other) => other.required && !sideAnswers.some((answer) => answer.questionId === other.id));
  const ship = () => submit({ ...sent, headSha: question.merge.headSha, answers: inOrder(round, [...sideAnswers, { questionId: question.id, pick: question.merge.ship[0] }]) });
  const back = () => submit({ ...sent, answers: inOrder(round, [...sideAnswers, { questionId: question.id, pick: sendBack, ...(comment ? { comment } : {}) }]) });
  const disabled = !available || state.status === "sending" || missing.length > 0;
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <Input multiline numberOfLines={3} label="Note for Send back (optional)" accessibilityLabel="Note for Send back" value={note} onChangeText={setNote} />
          <HStack gap={3} wrap>
            <Button color="success" isDisabled={disabled} onPress={() => void ship()}><ButtonText>Ship</ButtonText></Button>
            <Button variant="outline" color="warning" isDisabled={disabled || sendBack === undefined} onPress={() => void back()}><ButtonText>Send back</ButtonText></Button>
          </HStack>
          {missing.length > 0 ? <Alert status="warning" size="compact" message={`Answer the required ${missing.length === 1 ? "question" : "questions"} first: ${missing.map((other) => other.prompt).join("; ")}`} /> : null}
          {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
          {state.status === "failed" ? <Alert status="error" message={`Not sent: ${state.error}`} /> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}

/** A resolved outcome names the answer it applied; one that does not still says the gate is settled, without claiming a merge. */
function resolvedLine(answer: NonNullable<GateAnswer>, headSha: string): string {
  if (answer.choice === "merge") return `Merging at ${sha7(headSha)}`;
  return answer.choice === "send-back" ? "Sent back: the implementer gets your note" : "Answer applied";
}

/** The ledger's gate-answer lines; with no outcome yet the factory has not picked the answer up. */
function outcomeLine(answer: GateAnswer, headSha: string): { status: "info" | "success" | "warning"; message: string } {
  if (answer === undefined) return { status: "info", message: "Waiting for the factory" };
  const reason = answer.reason ?? "no reason given";
  const lines = {
    resolved: { status: "success", message: resolvedLine(answer, headSha) },
    already: { status: "info", message: "Already answered" },
    moved: { status: "warning", message: `Head moved to ${sha7(answer.currentHead ?? "unknown")}; a new round follows` },
    gone: { status: "warning", message: `Gate closed (${reason})` },
    refused: { status: "warning", message: `Not applied: ${reason}` },
    off: { status: "warning", message: "Not applied: gate answers are off in the factory" },
  } as const;
  return lines[answer.status];
}

function AnswerOutcome({ answer, headSha, state }: { answer: GateAnswer; headSha: string; state: SubmitState }): ReactNode {
  const already = state.status === "sent" && state.already;
  const { status, message } = already ? { status: "info" as const, message: "Already answered" } : outcomeLine(answer, headSha);
  return <Alert status={status} message={message} />;
}

/** The owner's picks on the round's other questions, held until the Ship or Send back press sends them. */
function useSideAnswers() {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [activeId, setActiveId] = useState<string>();
  return { answers, activeId, setActiveId, setAnswers };
}

type SideAnswers = ReturnType<typeof useSideAnswers>;

function SideQuestion({ question, position, side }: { question: Question; position: number; side: SideAnswers }): ReactNode {
  const { answers, activeId, setActiveId, setAnswers } = side;
  return (
    <RoundQuestion
      question={question}
      position={position}
      answer={answers[question.id]}
      onChoose={(choice) => setAnswers((current) => ({ ...current, [question.id]: chooseIn(question, current[question.id], choice) }))}
      onText={(text) => setAnswers((current) => ({ ...current, [question.id]: { text } }))}
      active={question.id === activeId}
      onActivate={() => setActiveId(question.id)}
    />
  );
}

function submittedAnswers(questions: readonly Question[], answers: Record<string, QuestionAnswer>): SubmittedAnswer[] {
  return questions.flatMap((question): SubmittedAnswer[] => {
    const answer = answers[question.id];
    if (answer === undefined) return [];
    if ("picks" in answer && answer.picks.length === 0) return [];
    if ("text" in answer && answer.text.trim() === "") return [];
    return [{ questionId: question.id, ...answer }];
  });
}

const inOrder = (round: ValidRound, answers: SubmittedAnswer[]): SubmittedAnswer[] => {
  const order = round.manifest.questions.map((question) => question.id);
  return answers.toSorted((left, right) => order.indexOf(left.questionId) - order.indexOf(right.questionId));
};
