import type { ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, HStack, Link, Pill, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import type { Question, Section as RoundSection } from "../../server/round-schema.js";
import { refToRoute } from "../refs.js";
import { openExternal } from "./homeLinks.js";
import { inOrder, submittedAnswers } from "./RoundAnswers.js";
import { LockedQuestion, unlessLocked } from "./RoundLock.js";
import { RoundNote } from "./RoundNote.js";
import { RoundQuestion } from "./RoundQuestion.js";
import { useRoundAnswers, type RoundAnswers } from "./RoundSections.js";
import { useRoundSend } from "./RoundSend.js";
import { PHONE_TAP } from "./phone.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type PrGroup = NonNullable<ValidRound["manifest"]["prGroups"]>[number];

const SHORT_SHA = 12;

/**
 * A post-merge visual feedback sheet (TP-5458): per merged PR what changed and one optional notes box. Everything in it
 * already merged, so it has no Ship, no check screen and nothing pending; sending it blank still answers it.
 */
export function FeedbackRound({ round }: { round: ValidRound }): ReactNode {
  const { submitting, locked, draft } = useRoundSend(round);
  const state = useRoundAnswers(locked ? [] : round.manifest.questions, round.notes, locked, undefined, draft);
  return (
    <VStack gap={4} testID="round-feedback-sheet">
      <Typography variant="body2" color="secondary">Every notes box is optional: send the sheet blank to mark it read.</Typography>
      {(round.manifest.prGroups ?? []).map((group) => (
        <FeedbackPr key={group.pr} group={group} round={round} state={state} locked={locked} />
      ))}
      <FeedbackSend round={round} state={state} submitting={submitting} />
    </VStack>
  );
}

function FeedbackPr({ group, round, state, locked }: { group: PrGroup; round: ValidRound; state: RoundAnswers; locked: boolean }): ReactNode {
  const sections = round.manifest.sections.filter((section) => group.sectionIds.includes(section.id));
  const questions = round.manifest.questions.filter((question) => sections.some((section) => section.questionIds.includes(question.id)));
  return (
    <Section testID={`round-feedback-pr-${group.pr}`}>
      <SectionHeader title={group.title ?? group.pr} />
      <SectionContent>
        <VStack gap={3}>
          <PrFacts group={group} />
          {sections.map((section) => <ChangedNotes key={section.id} section={section} />)}
          <PrFiles group={group} />
          {questions.map((question) => <NotesBox key={question.id} question={question} position={round.manifest.questions.indexOf(question) + 1} state={state} locked={locked} />)}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function PrFacts({ group }: { group: PrGroup }): ReactNode {
  const target = refToRoute(`pr:${group.pr}`);
  const url = target?.kind === "github" ? target.url : undefined;
  return (
    <HStack gap={2} align="center" wrap>
      {url === undefined ? <Typography variant="body2">{group.pr}</Typography> : <Link color="primary" href={url} isExternal onPress={() => openExternal(url)} testID={`round-feedback-link-${group.pr}`}>{group.pr}</Link>}
      <Pill variant="subtle" size="xs">{`head ${group.headSha.slice(0, SHORT_SHA)}`}</Pill>
      {group.task === undefined ? null : <Pill variant="subtle" size="xs">{`task ${group.task.id}`}</Pill>}
    </HStack>
  );
}

function ChangedNotes({ section }: { section: RoundSection }): ReactNode {
  return (
    <VStack gap={3}>
      {section.changed ? <RoundNote heading="Changed" text={section.changed} /> : null}
      {section.context ? <RoundNote heading="Context" text={section.context} /> : null}
    </VStack>
  );
}

/** Each visual path on its own line, so a long list wraps by path on a phone rather than mid-sentence. */
function PrFiles({ group }: { group: PrGroup }): ReactNode {
  const files = group.files ?? [];
  if (files.length === 0) return null;
  return (
    <VStack gap={1} testID={`round-feedback-files-${group.pr}`}>
      {files.map((file) => <Typography key={file.path} variant="mono" color="secondary" className="break-all">{file.path}</Typography>)}
    </VStack>
  );
}

function NotesBox({ question, position, state, locked }: { question: Question; position: number; state: RoundAnswers; locked: boolean }): ReactNode {
  return (
    <LockedQuestion locked={locked} testID={`round-entry-${question.id}`}>
      <RoundQuestion question={question} position={position} answer={state.answers[question.id]} onChoose={() => undefined} onText={unlessLocked(locked, (text: string) => state.write(question, text))} active={false} onActivate={() => undefined} />
    </LockedQuestion>
  );
}

function FeedbackSend({ round, state, submitting }: { round: ValidRound; state: RoundAnswers; submitting: ReturnType<typeof useRoundSend>["submitting"] }): ReactNode {
  const { available, state: sending, submit } = submitting;
  if (round.status === "withdrawn") return <Alert status="warning" message="Withdrawn: a newer sheet replaced this one." />;
  if (round.status === "sent" || sending.status === "sent") return <Alert status="success" message="Feedback sent" />;
  const answers = inOrder(round.manifest, submittedAnswers(round.manifest.questions, state.answers));
  const send = () => void submit({ id: round.id, manifestSha256: round.manifestSha256, general: "", answers });
  return (
    <VStack gap={2}>
      <Button color="primary" className={PHONE_TAP} isDisabled={!available || sending.status === "sending"} onPress={send} testID="round-feedback-send">
        <ButtonText>{answers.length === 0 ? "Mark read" : "Send notes"}</ButtonText>
      </Button>
      {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
      {sending.status === "failed" ? <Alert status="error" message={`Not sent: ${sending.error}`} /> : null}
    </VStack>
  );
}
