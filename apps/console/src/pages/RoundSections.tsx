import { useCallback, useState, type ReactNode } from "react";
import { Section, SectionContent, SectionHeader, VStack } from "@titan-design/react-ui";
import type { Manifest, Question, Section as RoundSection } from "../../server/round-schema.js";
import type { RoundNotes } from "../../server/rounds.js";
import type { ABAnswering } from "./QuestionAB.js";
import { RoundComment } from "./RoundComment.js";
import { RoundNote } from "./RoundNote.js";
import { RoundQuestion, chooseIn, choicesOf, useChoiceKeys, type QuestionAnswer } from "./RoundQuestion.js";

/** Questions in section order, then any no section claims. */
export function orderedQuestions(manifest: Manifest): { section: RoundSection | null; questions: Question[] }[] {
  const byId = new Map(manifest.questions.map((question) => [question.id, question]));
  const sections = manifest.sections.map((section) => ({ section, questions: section.questionIds.flatMap((questionId) => byId.get(questionId) ?? []) }));
  const claimed = new Set(sections.flatMap(({ questions }) => questions.map((question) => question.id)));
  const loose = manifest.questions.filter((question) => !claimed.has(question.id));
  return loose.length > 0 ? [...sections, { section: null, questions: loose }] : sections;
}

/** The page's picks, text, comments and option notes, and the active question that digit keys answer: at first the first one with choices. */
export function useRoundAnswers(questions: readonly Question[]) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [optionNotes, setOptionNotes] = useState<Record<string, Record<string, string>>>({});
  const [general, setGeneral] = useState("");
  const [activeId, setActiveId] = useState(() => questions.find((question) => choicesOf(question).length > 0)?.id);
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
  return { answers, comments, optionNotes, general, setGeneral, activeId, setActiveId, choose, write, comment, revise, note };
}

export type RoundAnswers = ReturnType<typeof useRoundAnswers>;

interface RoundSectionsProps {
  manifest: Manifest;
  state: RoundAnswers;
  /** Present where the page sends text answers; without it a text question shows a placeholder. */
  textAnswers?: boolean;
  /** A section's frames, drawn between its notes and its questions. */
  frames?: (section: RoundSection) => ReactNode;
  /** A sent round's free text: each comment then shows read-only in place of its box. */
  notes?: RoundNotes;
}

/** One question's A/B notes and "Neither" from the page's answers; choosing Neither makes the question the active one. */
function abAnswering({ optionNotes, note, revise, setActiveId }: RoundAnswers, question: Question, sent: boolean): ABAnswering {
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
export function RoundSections({ manifest, state, textAnswers = false, frames, notes }: RoundSectionsProps): ReactNode {
  const groups = orderedQuestions(manifest);
  const questions = groups.flatMap((group) => group.questions);
  const { answers, comments, activeId, setActiveId, choose, write, comment } = state;
  return groups.map(({ section, questions: inGroup }) => (
    <QuestionSection key={section?.id ?? "unsectioned"} section={section}>
      {section && frames ? frames(section) : null}
      {inGroup.map((question) => (
        <VStack key={question.id} gap={2}>
          <RoundQuestion
            question={question}
            position={questions.indexOf(question) + 1}
            answer={answers[question.id]}
            onChoose={(choice) => choose(question, choice)}
            onText={textAnswers ? (text) => write(question, text) : undefined}
            active={question.id === activeId}
            onActivate={() => setActiveId(question.id)}
            ab={abAnswering(state, question, notes !== undefined)}
          />
          <RoundComment question={question} value={comments[question.id] ?? ""} onChange={(text) => comment(question, text)} sent={notes && (notes.comments[question.id] ?? "")} />
        </VStack>
      ))}
    </QuestionSection>
  ));
}

function QuestionSection({ section, children }: { section: RoundSection | null; children: ReactNode }): ReactNode {
  return (
    <Section>
      <SectionHeader title={section?.title ?? "Other questions"} subtitle={section?.deciding} />
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
      {section.changed ? <RoundNote heading="Changed" text={section.changed} /> : null}
      {section.context ? <RoundNote text={section.context} /> : null}
    </VStack>
  );
}
