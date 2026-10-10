import { useCallback, useState, type ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, DateTime, HStack, Heading, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest, Question, Section as RoundSection } from "@titan-design/review-schema";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { RoundQuestion, chooseIn, choicesOf, useChoiceKeys, type QuestionAnswer } from "./RoundQuestion.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

/** One round: its sections, and each question answerable by pointer or keys 1-9. Picks stay in the page. */
export function RoundDetailPage({ id }: { id: string }): ReactNode {
  const detail = useQuery("rounds.get", { id });
  if (detail.status === "loading") return <Spinner size="sm" label="Loading round" />;
  if (detail.data === undefined) return <Framed id={id}><Alert status="error" message={`Could not load ${id}: ${detail.error.message}`} /></Framed>;
  const round = detail.data;
  if (!round.valid) return <Framed id={id}><Alert status="error" message={`This round does not pass the round schema: ${round.reason}`} /></Framed>;
  return (
    <Framed id={id}>
      <RoundHeading round={round} />
      {round.design ? <DesignNotice storybookUrl={round.storybookUrl} /> : <QuestionRound round={round} />}
    </Framed>
  );
}

function Framed({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "rounds" })}>Rounds</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{id}</BreadcrumbItem>
      </Breadcrumbs>
      {children}
    </VStack>
  );
}

function RoundHeading({ round }: { round: ValidRound }): ReactNode {
  const { manifest } = round;
  return (
    <VStack gap={1}>
      <HStack gap={3} align="center" wrap>
        <Heading level={3}>{`${manifest.unit} · round ${manifest.round}`}</Heading>
        <Pill variant="subtle" size="xs">{round.status}</Pill>
        <DateTime value={round.updatedAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </HStack>
      {manifest.context ? <Typography variant="body2" color="secondary">{manifest.context}</Typography> : null}
    </VStack>
  );
}

/** The console renders no frames, so a round with a strip of them is answered in the review harness. */
function DesignNotice({ storybookUrl }: { storybookUrl: string | null }): ReactNode {
  return (
    <Alert status="info" message="design round: open in the harness">
      {storybookUrl ? <Typography variant="caption" color="secondary">{`Its frames come from Storybook at ${storybookUrl}`}</Typography> : null}
    </Alert>
  );
}

/** Questions in section order, then any no section claims. */
function orderedQuestions(manifest: Manifest): { section: RoundSection | null; questions: Question[] }[] {
  const byId = new Map(manifest.questions.map((question) => [question.id, question]));
  const sections = (manifest.sections ?? []).map((section) => ({ section, questions: section.questionIds.flatMap((questionId) => byId.get(questionId) ?? []) }));
  const claimed = new Set(sections.flatMap(({ questions }) => questions.map((question) => question.id)));
  const loose = manifest.questions.filter((question) => !claimed.has(question.id));
  return loose.length > 0 ? [...sections, { section: null, questions: loose }] : sections;
}

/** The page's picks, and the active question that digit keys answer: at first the first one with choices. */
function useRoundAnswers(questions: readonly Question[]) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [activeId, setActiveId] = useState(() => questions.find((question) => choicesOf(question).length > 0)?.id);
  const active = questions.find((question) => question.id === activeId);
  const choose = useCallback(
    (question: Question, choice: string) => setAnswers((current) => ({ ...current, [question.id]: chooseIn(question, current[question.id], choice) })),
    [],
  );
  const chooseActive = useCallback((choice: string) => (active ? choose(active, choice) : undefined), [active, choose]);
  useChoiceKeys(active, chooseActive);
  return { answers, activeId, setActiveId, choose };
}

function QuestionRound({ round }: { round: ValidRound }): ReactNode {
  const groups = orderedQuestions(round.manifest);
  const questions = groups.flatMap((group) => group.questions);
  const { answers, activeId, setActiveId, choose } = useRoundAnswers(questions);
  return (
    <VStack gap={4}>
      <Alert status="info" size="compact" message="Read-only: picks stay in this page and are not sent." />
      {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">Recommendations show once the round is answered.</Typography> : null}
      {groups.map(({ section, questions: inGroup }) => (
        <QuestionSection key={section?.id ?? "unsectioned"} section={section}>
          {inGroup.map((question) => (
            <RoundQuestion
              key={question.id}
              question={question}
              position={questions.indexOf(question) + 1}
              answer={answers[question.id]}
              onChoose={(choice) => choose(question, choice)}
              active={question.id === activeId}
              onActivate={() => setActiveId(question.id)}
            />
          ))}
        </QuestionSection>
      ))}
    </VStack>
  );
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
