import { useCallback, useState, type ReactNode } from "react";
import { Section, SectionContent, SectionHeader, VStack } from "@titan-design/react-ui";
import type { Manifest, Question, Section as RoundSection } from "../../server/round-schema.js";
import type { RoundNotes } from "../../server/rounds.js";
import type { ABAnswering } from "./QuestionAB.js";
import { heldFromSent } from "./RoundAnswers.js";
import { RoundComment } from "./RoundComment.js";
import { useFrameFeedback, type ActiveTarget } from "./FrameFeedback.js";
import { LockedQuestion, sentComment, unlessLocked } from "./RoundLock.js";
import { RoundNote } from "./RoundNote.js";
import { RoundQuestion, chooseIn, choicesOf, useChoiceKeys, type QuestionAnswer } from "./RoundQuestion.js";
import { pageIdOf } from "./round-pages.js";

/** Questions in section order, then any no section claims. */
export function orderedQuestions(manifest: Manifest): { section: RoundSection | null; questions: Question[] }[] {
  const byId = new Map(manifest.questions.map((question) => [question.id, question]));
  const sections = manifest.sections.map((section) => ({ section, questions: section.questionIds.flatMap((questionId) => byId.get(questionId) ?? []) }));
  const claimed = new Set(sections.flatMap(({ questions }) => questions.map((question) => question.id)));
  const loose = manifest.questions.filter((question) => !claimed.has(question.id));
  return loose.length > 0 ? [...sections, { section: null, questions: loose }] : sections;
}

/** A Ship round's Addressed ticks on earlier rounds (TP-3741) and the questions marked follow-up (TP-3346). */
function useShipMarks() {
  const [addressed, setAddressed] = useState<number[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const toggleAddressed = useCallback((round: number, checked: boolean) => setAddressed((current) => [...current.filter((each) => each !== round), ...(checked ? [round] : [])]), []);
  const setFollowUp = useCallback((questionId: string, followUp: boolean) => setFollowUps((current) => [...current.filter((each) => each !== questionId), ...(followUp ? [questionId] : [])]), []);
  return { addressed, toggleAddressed, followUps, setFollowUp };
}

/**
 * The page's picks, text, comments, option notes, frame verdicts and Ship marks, and the active question that digit keys
 * answer (at first the first one with choices) or frame that letter keys judge. A sent round's `notes` seed the answers,
 * so a reload shows them as sent.
 */
export function useRoundAnswers(questions: readonly Question[], notes?: RoundNotes) {
  const [held] = useState(() => heldFromSent(notes));
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>(held.answers);
  const [comments, setComments] = useState<Record<string, string>>(held.comments);
  const [optionNotes, setOptionNotes] = useState<Record<string, Record<string, string>>>(held.optionNotes);
  const [general, setGeneral] = useState(held.general);
  const marks = useShipMarks();
  const [target, setTarget] = useState<ActiveTarget | undefined>(() => firstChoosable(questions));
  const activeId = target?.kind === "question" ? target.id : undefined;
  const setActiveId = useCallback((id: string | undefined) => setTarget(id === undefined ? undefined : { kind: "question", id }), []);
  const frames = useFrameFeedback(target, setTarget);
  const active = questions.find((question) => question.id === activeId);
  const choose = useCallback(
    (question: Question, choice: string) => setAnswers((current) => ({ ...current, [question.id]: chooseIn(question, current[question.id], choice) })),
    [],
  );
  const write = useCallback((question: Question, text: string) => setAnswers((current) => ({ ...current, [question.id]: { text } })), []);
  const comment = useCallback((question: Question, text: string) => setComments((current) => ({ ...current, [question.id]: text })), []);
  const revise = useCallback((question: Question) => setAnswers((current) => ({ ...current, [question.id]: { revisionRequested: true } })), []);
  const note = useCallback(
    (question: Question, option: string, text: string) => setOptionNotes((current) => ({ ...current, [question.id]: { ...current[question.id], [option]: text } })),
    [],
  );
  const chooseActive = useCallback((choice: string) => (active ? choose(active, choice) : undefined), [active, choose]);
  useChoiceKeys(active, chooseActive);
  return { answers, comments, optionNotes, general, setGeneral, activeId, setActiveId, choose, write, comment, revise, note, frames, ...marks };
}

function firstChoosable(questions: readonly Question[]): ActiveTarget | undefined {
  const id = questions.find((question) => choicesOf(question).length > 0)?.id;
  return id === undefined ? undefined : { kind: "question", id };
}

export type RoundAnswers = ReturnType<typeof useRoundAnswers>;

export interface RoundSectionsProps {
  manifest: Manifest;
  state: RoundAnswers;
  /** Present where the page sends text answers; without it a text question shows a placeholder. */
  textAnswers?: boolean;
  /** A section's frames, drawn between its notes and its questions. */
  frames?: (section: RoundSection) => ReactNode;
  /** Sent or sending: every question shows its answer as given and takes no more edits. */
  locked?: boolean;
  /** A paged round draws only this page's section; without it every section shows. */
  page?: string;
}

/** One question's A/B notes and "Neither" from the page's answers; choosing Neither makes the question the active one. */
export function abAnswering({ optionNotes, note, revise, setActiveId }: RoundAnswers, question: Question, sent: boolean): ABAnswering {
  return {
    notes: optionNotes[question.id] ?? {},
    onNote: (option, text) => note(question, option, text),
    onNeither: () => {
      setActiveId(question.id);
      revise(question);
    },
    sent,
  };
}

/** Every section of a round with its questions, numbered across the round. */
export function RoundSections({ manifest, state, textAnswers = false, frames, locked = false, page }: RoundSectionsProps): ReactNode {
  const groups = orderedQuestions(manifest);
  const questions = groups.flatMap((group) => group.questions);
  const { answers, comments, activeId, setActiveId, choose, write, comment } = state;
  const shown = page === undefined ? groups : groups.filter((group) => pageIdOf(group.section) === page);
  return shown.map(({ section, questions: inGroup }) => (
    <QuestionSection key={pageIdOf(section)} section={section}>
      {section && frames ? frames(section) : null}
      {inGroup.map((question) => (
        <LockedQuestion key={question.id} locked={locked} testID={`round-entry-${question.id}`}>
          <RoundQuestion
            question={question}
            position={questions.indexOf(question) + 1}
            answer={answers[question.id]}
            onChoose={unlessLocked(locked, (choice: string) => choose(question, choice))}
            onText={textAnswers ? unlessLocked(locked, (text: string) => write(question, text)) : undefined}
            active={!locked && question.id === activeId}
            onActivate={unlessLocked(locked, () => setActiveId(question.id))}
            ab={abAnswering(state, question, locked)}
          />
          <RoundComment question={question} value={comments[question.id] ?? ""} onChange={unlessLocked(locked, (text: string) => comment(question, text))} sent={sentComment(comments, question, locked)} />
        </LockedQuestion>
      ))}
    </QuestionSection>
  ));
}

function QuestionSection({ section, children }: { section: RoundSection | null; children: ReactNode }): ReactNode {
  return (
    <Section>
      <SectionHeader title={section?.title ?? "Other questions"} />
      <SectionContent>
        <VStack gap={3}>
          {section ? <SectionNotes section={section} /> : null}
          {children}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function SectionNotes({ section }: { section: RoundSection }): ReactNode {
  return (
    <VStack gap={3}>
      {section.deciding ? <RoundNote heading="Deciding" text={section.deciding} /> : null}
      {section.changed ? <RoundNote heading="Changed" text={section.changed} /> : null}
      {section.context ? <RoundNote heading="Context" text={section.context} /> : null}
    </VStack>
  );
}
