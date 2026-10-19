import { useCallback, useState, type ReactNode } from "react";
import { Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question, Section as RoundSection } from "../../server/round-schema.js";
import { RoundQuestion, chooseIn, choicesOf, useChoiceKeys, type QuestionAnswer } from "./RoundQuestion.js";

/** Questions in section order, then any no section claims. */
export function orderedQuestions(manifest: Manifest): { section: RoundSection | null; questions: Question[] }[] {
  const byId = new Map(manifest.questions.map((question) => [question.id, question]));
  const sections = manifest.sections.map((section) => ({ section, questions: section.questionIds.flatMap((questionId) => byId.get(questionId) ?? []) }));
  const claimed = new Set(sections.flatMap(({ questions }) => questions.map((question) => question.id)));
  const loose = manifest.questions.filter((question) => !claimed.has(question.id));
  return loose.length > 0 ? [...sections, { section: null, questions: loose }] : sections;
}

/** The page's picks and text, and the active question that digit keys answer: at first the first one with choices. */
export function useRoundAnswers(questions: readonly Question[]) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [activeId, setActiveId] = useState(() => questions.find((question) => choicesOf(question).length > 0)?.id);
  const active = questions.find((question) => question.id === activeId);
  const choose = useCallback(
    (question: Question, choice: string) => setAnswers((current) => ({ ...current, [question.id]: chooseIn(question, current[question.id], choice) })),
    [],
  );
  const write = useCallback((question: Question, text: string) => setAnswers((current) => ({ ...current, [question.id]: { text } })), []);
  const chooseActive = useCallback((choice: string) => (active ? choose(active, choice) : undefined), [active, choose]);
  useChoiceKeys(active, chooseActive);
  return { answers, activeId, setActiveId, choose, write };
}

export type RoundAnswers = ReturnType<typeof useRoundAnswers>;

interface RoundSectionsProps {
  manifest: Manifest;
  state: RoundAnswers;
  /** Present where the page sends text answers; without it a text question shows a placeholder. */
  textAnswers?: boolean;
  /** A section's frames, drawn between its notes and its questions. */
  frames?: (section: RoundSection) => ReactNode;
}

/** Every section of a round with its questions, numbered across the round. */
export function RoundSections({ manifest, state, textAnswers = false, frames }: RoundSectionsProps): ReactNode {
  const groups = orderedQuestions(manifest);
  const questions = groups.flatMap((group) => group.questions);
  const { answers, activeId, setActiveId, choose, write } = state;
  return groups.map(({ section, questions: inGroup }) => (
    <QuestionSection key={section?.id ?? "unsectioned"} section={section}>
      {section && frames ? frames(section) : null}
      {inGroup.map((question) => (
        <RoundQuestion
          key={question.id}
          question={question}
          position={questions.indexOf(question) + 1}
          answer={answers[question.id]}
          onChoose={(choice) => choose(question, choice)}
          onText={textAnswers ? (text) => write(question, text) : undefined}
          active={question.id === activeId}
          onActivate={() => setActiveId(question.id)}
        />
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
    <VStack gap={1}>
      {section.changed ? <Typography variant="caption">{`Changed: ${section.changed}`}</Typography> : null}
      {section.context ? <Typography variant="caption" color="secondary">{`Context only: ${section.context}`}</Typography> : null}
    </VStack>
  );
}
