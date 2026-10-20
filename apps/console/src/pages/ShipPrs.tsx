import { useState, type ReactNode } from "react";
import {
  Alert, Button, ButtonText, Card, CardContent, HStack, Input, MarkdownProse, Pill, Section, SectionContent, SectionHeader, Typography, VStack,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RoundDetail } from "../../server/rounds.js";
import type { Manifest, Question, Section as RoundSection } from "../../server/round-schema.js";
import { sendBackBlocker, shipBlockers } from "../../server/ship-blockers.js";
import { useSubmit } from "../data/submit.js";
import { QuestionFrames } from "./QuestionFrames.js";
import { inOrder, submittedAnswers } from "./RoundAnswers.js";
import { RoundGeneral, SentComment, SentGeneral } from "./RoundComment.js";
import { QuestionFacts } from "./RoundQuestion.js";
import { useWithSeen } from "./RoundReveal.js";
import { Montages } from "./ShipMontages.js";
import { ShipBlockedReason, ShipPriorFeedback } from "./ShipPriorFeedback.js";
import { useRoundAnswers, type RoundAnswers } from "./RoundSections.js";
import { ShipNotices, SideQuestion, sideMarks } from "./ShipSide.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type PickOne = Extract<Question, { kind: "pick-one" }>;
type MergeQuestion = PickOne & { merge: NonNullable<PickOne["merge"]> };
type PrGroup = NonNullable<Manifest["prGroups"]>[number];
type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];
type Verdict = "ship" | "back";

/** One PR of the round: its Ship question, its group when the round has one, and the sections, side questions and frames about it. */
interface PrUnit {
  question: MergeQuestion;
  pr: string;
  group?: PrGroup;
  sections: RoundSection[];
  sideQuestions: Question[];
  keys: Set<string>;
}

const sha7 = (sha: string): string => sha.slice(0, 7);
const sendBackOf = (question: MergeQuestion): string | undefined => question.options.find((option) => !question.merge.ship.includes(option));

/** A Ship question in no PR group keeps the sections that ask it, so a hand-written round still shows its frames. */
function prUnits(manifest: Manifest, merges: readonly MergeQuestion[]): PrUnit[] {
  const { sections } = manifest;
  const isMerge = new Set<Question>(merges);
  return merges.map((question) => {
    const pr = `${question.merge.repo}#${question.merge.pr}`;
    const group = manifest.prGroups?.find((candidate) => candidate.pr === pr);
    const own = sections.filter((section) => (group ? group.sectionIds.includes(section.id) : section.questionIds.includes(question.id)));
    const asked = new Set(own.flatMap((section) => section.questionIds));
    const sideQuestions = manifest.questions.filter((each) => asked.has(each.id) && !isMerge.has(each));
    return { question, pr, ...(group && { group }), sections: own, sideQuestions, keys: new Set(own.flatMap((section) => section.variantKeys)) };
  });
}

/** Ship or Send back per PR, and each Send back's note, held until the one send. */
function useVerdicts() {
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const choose = (id: string, verdict: Verdict) => setVerdicts((current) => ({ ...current, [id]: verdict }));
  const note = (id: string, text: string) => setNotes((current) => ({ ...current, [id]: text }));
  return { verdicts, notes, choose, note };
}

type Verdicts = ReturnType<typeof useVerdicts>;

function mergeAnswer(question: MergeQuestion, verdicts: Verdicts): SubmittedAnswer[] {
  const verdict = verdicts.verdicts[question.id];
  const comment = verdicts.notes[question.id]?.trim() ?? "";
  if (verdict === "ship") return [{ questionId: question.id, pick: question.merge.ship[0] }];
  const sendBack = sendBackOf(question);
  return verdict === "back" && sendBack !== undefined ? [{ questionId: question.id, pick: sendBack, ...(comment ? { comment } : {}) }] : [];
}

/** Everything the page would send: side answers, then each PR's Ship or Send back, in round order. */
function draftAnswers(round: ValidRound, units: readonly PrUnit[], side: RoundAnswers, verdicts: Verdicts): SubmittedAnswer[] {
  const merges = new Set<Question>(units.map((unit) => unit.question));
  const sideAnswers = submittedAnswers(round.manifest.questions.filter((question) => !merges.has(question)), side.answers, side.comments, side.optionNotes);
  return inOrder(round.manifest, [...sideAnswers, ...units.flatMap((unit) => mergeAnswer(unit.question, verdicts))]);
}

interface PrsState {
  round: ValidRound;
  units: PrUnit[];
  side: RoundAnswers;
  verdicts: Verdicts;
  answers: SubmittedAnswer[];
  blockersOf: (unit: PrUnit) => string[];
  /** Why this PR's Send back is off: it has no note of its own and the round has none. */
  sendBackBlockerOf: (unit: PrUnit) => string | undefined;
  /** Sent or sending: side answers show as given and take no more edits. */
  locked: boolean;
  sent: boolean;
}

/** A round with one Ship question per PR (TP-3329): each PR's proposal, changes, frames and own Ship or Send back, then one send. */
export function ShipPrsRound({ round, merges }: { round: ValidRound; merges: readonly MergeQuestion[] }): ReactNode {
  const submitting = useSubmit();
  const locked = round.status === "sent" || submitting.state.status === "sending" || submitting.state.status === "sent";
  const units = prUnits(round.manifest, merges);
  // Locked, no question is handed over, so no digit key can change an answer already sent.
  const side = useRoundAnswers(locked ? [] : round.manifest.questions.filter((question) => !units.some((unit) => unit.question === question)), round.notes);
  const verdicts = useVerdicts();
  const withSeen = useWithSeen();
  const answers = withSeen(draftAnswers(round, units, side, verdicts));
  const draft = { answers, general: side.general.trim(), addressed: side.addressed, followUps: side.followUps };
  // A PR's own Send back note is dropped when it switches to Ship, so it never blocks that Ship.
  const blockersOf = (unit: PrUnit) => shipBlockers(round.manifest, round.priorFeedback ?? [], { ...draft, answers: answers.filter((answer) => answer.questionId !== unit.question.id) }, unit.question.id);
  // Read from the note box, not the draft, so Send back turns on before it is chosen.
  const sendBackBlockerOf = (unit: PrUnit) => sendBackBlocker({ answers: [{ questionId: unit.question.id, comment: verdicts.notes[unit.question.id] ?? "" }], general: draft.general }, unit.question.id);
  const state: PrsState = { round, units, side, verdicts, answers, blockersOf, sendBackBlockerOf, locked, sent: round.status === "sent" || submitting.state.status === "sent" };
  return (
    <VStack gap={6}>
      <PrsHeading round={round} units={units} />
      {units.map((unit) => <PrSection key={unit.question.id} unit={unit} state={state} />)}
      <SharedQuestions state={state} />
      {state.sent ? null : <ShipPriorFeedback items={round.priorFeedback ?? []} addressed={side.addressed} onToggle={side.toggleAddressed} />}
      {state.sent ? <SentGeneral text={round.notes?.general} /> : <PrsSend state={state} submitting={submitting} />}
    </VStack>
  );
}

function PrsHeading({ round, units }: { round: ValidRound; units: readonly PrUnit[] }): ReactNode {
  const leftover = new Set(round.manifest.variants.map((variant) => variant.key).filter((key) => !units.some((unit) => unit.keys.has(key))));
  return (
    <VStack gap={4}>
      <Card variant="subtle">
        <CardContent>
          <VStack gap={2}>
            <Typography variant="subtitle1">{`${units.length} PRs in this round: each ships or goes back on its own`}</Typography>
            <Typography variant="caption">{units.map((unit) => `${unit.pr} at ${sha7(unit.question.merge.headSha)}`).join(" · ")}</Typography>
            {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">The recommendation is hidden until you answer; reveal it first if you want it.</Typography> : null}
          </VStack>
        </CardContent>
      </Card>
      {leftover.size > 0 ? <Montages round={round} keys={leftover} /> : null}
    </VStack>
  );
}

function PrSection({ unit, state }: { unit: PrUnit; state: PrsState }): ReactNode {
  const { question, group } = unit;
  return (
    <Section>
      <SectionHeader title={group?.title ?? unit.pr} subtitle={`${unit.pr} at ${sha7(question.merge.headSha)}`} />
      <SectionContent>
        <div className="flex flex-col gap-4" data-testid={`pr-${unit.pr}`}>
          <PrProposal unit={unit} pick={state.round.notes?.answers[question.id]?.pick ?? mergeAnswer(question, state.verdicts)[0]?.pick} />
          <Montages round={state.round} keys={unit.keys} merge={question.merge} />
          {unit.sideQuestions.map((each) => (
            <SideQuestion key={each.id} round={state.round} question={each} position={state.round.manifest.questions.indexOf(each) + 1} side={state.side} locked={state.locked} />
          ))}
          {state.sent ? <PrSent unit={unit} state={state} /> : <PrDecision unit={unit} state={state} />}
        </div>
      </SectionContent>
    </Section>
  );
}

/** What the PR proposes and changes, as its group and sections describe it; `pick` is its Ship or Send back, held or sent. */
function PrProposal({ unit, pick }: { unit: PrUnit; pick: string | undefined }): ReactNode {
  const { question, group } = unit;
  const changed = unit.sections.flatMap((section) => (section.changed ? [section.changed] : []));
  return (
    <Card variant="subtle">
      <CardContent>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap>
            {group?.kind ? <Pill variant="subtle" size="xs">{group.kind}</Pill> : null}
            {group?.task ? <Pill variant="subtle" size="xs">{group.task.id}</Pill> : null}
            <Typography variant="subtitle2">{question.prompt}</Typography>
          </HStack>
          {group?.description ? <MarkdownProse body={group.description} testID={`proposal-${unit.pr}`} /> : null}
          {changed.map((line) => <Typography key={line} variant="caption">{`Changed: ${line}`}</Typography>)}
          <QuestionFrames question={question} />
          <QuestionFacts question={question} answer={pick === undefined ? undefined : { pick }} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function PrDecision({ unit, state }: { unit: PrUnit; state: PrsState }): ReactNode {
  const { question, pr } = unit;
  const verdict = state.verdicts.verdicts[question.id];
  const blockers = state.blockersOf(unit);
  const noNote = state.sendBackBlockerOf(unit);
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <HStack gap={3} wrap>
            <Button color="success" variant={verdict === "ship" ? "solid" : "outline"} accessibilityLabel={`Ship ${pr}`} accessibilityState={{ selected: verdict === "ship" }} isDisabled={blockers.length > 0} onPress={() => state.verdicts.choose(question.id, "ship")}>
              <ButtonText>Ship</ButtonText>
            </Button>
            <Button color="warning" variant={verdict === "back" ? "solid" : "outline"} accessibilityLabel={`Send back ${pr}`} accessibilityState={{ selected: verdict === "back" }} isDisabled={sendBackOf(question) === undefined || noNote !== undefined} onPress={() => state.verdicts.choose(question.id, "back")}>
              <ButtonText>Send back</ButtonText>
            </Button>
          </HStack>
          {verdict === "ship" ? null : (
            <Input multiline numberOfLines={3} label="Note for Send back" accessibilityLabel={`Note for Send back on ${pr}`} value={state.verdicts.notes[question.id] ?? ""} onChangeText={(text) => state.verdicts.note(question.id, text)} />
          )}
          {noNote !== undefined && verdict !== "ship" ? <Typography variant="caption" color="secondary" testID={`send-back-note-${pr}`}>{noNote}</Typography> : null}
          <ShipBlockedReason reasons={blockers} />
        </VStack>
      </CardContent>
    </Card>
  );
}

/** Sent, what the owner chose for this PR: from the round's feedback once it reloads, from the page until then. */
function PrSent({ unit, state }: { unit: PrUnit; state: PrsState }): ReactNode {
  const { question, pr } = unit;
  const pick = state.round.notes?.answers[question.id]?.pick ?? state.answers.find((answer) => answer.questionId === question.id)?.pick;
  const shipped = pick !== undefined && question.merge.ship.includes(pick);
  const message = pick === undefined ? `${pr}: no answer recorded` : shipped ? `${pr}: shipped at ${sha7(question.merge.headSha)}; the factory merges it at that head` : `${pr}: sent back`;
  return (
    <VStack gap={2}>
      <Alert status={shipped ? "success" : "info"} message={message} />
      <SentComment questionId={question.id} text={state.round.notes?.comments[question.id]} />
    </VStack>
  );
}

/** Side questions no PR group claims bear on every PR. */
function SharedQuestions({ state }: { state: PrsState }): ReactNode {
  const claimed = new Set<Question>(state.units.flatMap((unit) => [unit.question, ...unit.sideQuestions]));
  const shared = state.round.manifest.questions.filter((question) => !claimed.has(question));
  if (shared.length === 0) return null;
  return (
    <Section>
      <SectionHeader title="About every PR" subtitle="These answers count against each PR's Ship." />
      <SectionContent>
        <VStack gap={4}>
          {shared.map((each) => <SideQuestion key={each.id} round={state.round} question={each} position={state.round.manifest.questions.indexOf(each) + 1} side={state.side} locked={state.locked} />)}
        </VStack>
      </SectionContent>
    </Section>
  );
}

/** `rounds.submit` args: every shipped PR's own head in `heads`, the Addressed ticks only when something ships. */
function sendArgs(state: PrsState) {
  const shipped = state.units.filter((unit) => state.verdicts.verdicts[unit.question.id] === "ship");
  const { addressed, followUps } = sideMarks(state.side);
  return {
    id: state.round.id, manifestSha256: state.round.manifestSha256, general: state.side.general.trim(), answers: state.answers, ...followUps,
    ...(shipped.length > 0 && { ...addressed, heads: Object.fromEntries(shipped.map((unit) => [unit.question.id, unit.question.merge.headSha])) }),
  };
}

/** Why the one send is off: an undecided PR, a Ship that is now blocked, or a Send back whose note was cleared. */
function sendProblems(state: PrsState): string[] {
  const prsWhere = (test: (unit: PrUnit, verdict: Verdict | undefined) => boolean) => state.units.filter((unit) => test(unit, state.verdicts.verdicts[unit.question.id])).map((unit) => unit.pr);
  const undecided = prsWhere((_, verdict) => verdict === undefined);
  const blocked = prsWhere((unit, verdict) => verdict === "ship" && state.blockersOf(unit).length > 0);
  const noNote = prsWhere((unit, verdict) => verdict === "back" && state.sendBackBlockerOf(unit) !== undefined);
  return [
    ...(undecided.length > 0 ? [`choose Ship or Send back for ${undecided.join(", ")}`] : []),
    ...(blocked.length > 0 ? [`Ship is blocked for ${blocked.join(", ")}`] : []),
    ...(noNote.length > 0 ? [`add a note to send back ${noNote.join(", ")}`] : []),
  ];
}

function PrsSend({ state, submitting }: { state: PrsState; submitting: ReturnType<typeof useSubmit> }): ReactNode {
  const { available, state: sending, submit } = submitting;
  // Decisions 166 and 513: an unanswered required side question holds neither Ship nor Send back.
  const problems = sendProblems(state);
  const disabled = !available || sending.status === "sending" || problems.length > 0;
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <RoundGeneral value={state.side.general} onChange={state.side.setGeneral} />
          <HStack gap={3} wrap>
            <Button isDisabled={disabled} onPress={() => void submit(sendArgs(state))}><ButtonText>Send answers</ButtonText></Button>
          </HStack>
          {problems.length > 0 ? <Alert status="info" size="compact" message={`Before sending: ${problems.join("; ")}.`} testID="prs-send-problems" /> : null}
          <ShipNotices blockers={[]} noNote={undefined} available={available} state={sending} />
        </VStack>
      </CardContent>
    </Card>
  );
}
