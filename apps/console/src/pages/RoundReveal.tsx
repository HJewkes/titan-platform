import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, HStack, Pill, Typography, VStack } from "@titan-design/react-ui";
import { z } from "zod";
import type { ConsoleCommands } from "../../server/commands.js";
import { RecommendationSchema } from "../../server/review-schema-0.3/schema.js";
import { agrees } from "../../server/round-feedback.js";
import type { Question } from "../../server/round-schema.js";
import type { RoundDetail } from "../../server/rounds.js";
import { useAnswerSource } from "../data/submit.js";
import { InlineMarkdown, RoundProse, plainText } from "./RoundMarkdown.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type Recommendation = ConsoleCommands["rounds.reveal"]["result"]["recommendation"];
type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/**
 * An after-answer round's reveals (TP-3774): the recommendations `rounds.reveal` handed back, which ones the owner
 * has open, and which answers landed while one showed, so the submit tags them `recommendationSeen`.
 */
interface Reveals {
  revealable: ReadonlySet<string>;
  /** An open `shown` round: every answer is given with its recommendation on screen. */
  shownRound: boolean;
  fetched: Readonly<Record<string, Recommendation>>;
  open: Readonly<Record<string, boolean>>;
  seen: Readonly<Record<string, boolean>>;
  failed: Readonly<Record<string, string>>;
  /** False on a snapshot page, which can call nothing. */
  live: boolean;
  fetch: (questionId: string) => void;
  setOpen: (questionId: string, open: boolean) => void;
  setSeen: (questionId: string, seen: boolean) => void;
}

const RevealContext = createContext<Reveals | null>(null);

const RevealReply = z.object({ recommendation: RecommendationSchema });

const sentSeen = (round: ValidRound): Record<string, boolean> =>
  Object.fromEntries(Object.entries(round.notes?.answers ?? {}).flatMap(([id, answer]) => (answer.recommendationSeen ? [[id, true] as const] : [])));

function useFetchReveal(round: ValidRound, record: (questionId: string, result: { recommendation?: Recommendation; error?: string }) => void) {
  const source = useAnswerSource();
  const asked = useRef(new Set<string>());
  const fetch = useCallback(
    (questionId: string) => {
      if (source === null || asked.current.has(questionId)) return;
      asked.current.add(questionId);
      void source.call("rounds.reveal", { id: round.id, manifestSha256: round.manifestSha256, questionId }).then((envelope) => {
        const reply = envelope.ok ? RevealReply.safeParse(envelope.data) : null;
        if (!reply?.success) asked.current.delete(questionId);
        if (reply?.success) record(questionId, { recommendation: reply.data.recommendation });
        else record(questionId, { error: envelope.ok ? "the reply was not a recommendation" : envelope.error });
      });
    },
    [source, round.id, round.manifestSha256, record],
  );
  return { fetch, live: source !== null };
}

export function RoundRevealProvider({ round, children }: { round: ValidRound; children: ReactNode }): ReactNode {
  const [fetched, setFetched] = useState<Record<string, Recommendation>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [open, setOpenState] = useState<Record<string, boolean>>({});
  const [seen, setSeenState] = useState<Record<string, boolean>>(() => sentSeen(round));
  const record = useCallback((questionId: string, { recommendation, error }: { recommendation?: Recommendation; error?: string }) => {
    if (recommendation) setFetched((current) => ({ ...current, [questionId]: recommendation }));
    setFailed((current) => ({ ...current, [questionId]: error ?? "" }));
  }, []);
  const { fetch, live } = useFetchReveal(round, record);
  const setOpen = useCallback((questionId: string, next: boolean) => setOpenState((current) => ({ ...current, [questionId]: next })), []);
  const setSeen = useCallback((questionId: string, next: boolean) => setSeenState((current) => (current[questionId] === next ? current : { ...current, [questionId]: next })), []);
  const revealable = useMemo(() => new Set(round.revealable), [round.revealable]);
  const shownRound = round.manifest.recommendations === "shown" && round.status === "open";
  const value = useMemo(() => ({ revealable, shownRound, fetched, open, seen, failed, live, fetch, setOpen, setSeen }), [revealable, shownRound, fetched, open, seen, failed, live, fetch, setOpen, setSeen]);
  return <RevealContext.Provider value={value}>{children}</RevealContext.Provider>;
}

/** An empty pick-many or blank text answers nothing, as the server's `isAnswered` reads it. */
function isHeldAnswer(answer: QuestionAnswer | undefined): boolean {
  if (answer === undefined) return false;
  if ("picks" in answer) return answer.picks.length > 0;
  if ("text" in answer) return answer.text.trim() !== "";
  return true;
}

interface ShownRecommendation {
  recommendation: Recommendation | undefined;
  /** Shown: in a `shown` or sent round, once answered, or while the owner has it revealed. */
  visible: boolean;
  /** The round or the answer shows it, so the reveal cannot hide it. */
  locked: boolean;
  /** Present only where `rounds.reveal` can hand the recommendation over. */
  toggle?: () => void;
  seen: boolean;
  error: string | undefined;
}

/** What the page shows of a question's recommendation, as the harness's `recommendationVisible` decides it. */
export function useRecommendation(question: Question, answer: QuestionAnswer | undefined): ShownRecommendation {
  const reveals = useContext(RevealContext);
  const sent = question.kind === "text" ? undefined : question.recommendation;
  const answered = isHeldAnswer(answer);
  const seen = reveals?.seen[question.id] === true || (reveals?.shownRound === true && answered);
  if (sent !== undefined) return { recommendation: sent, visible: true, locked: true, seen, error: undefined };
  if (reveals === null || !reveals.revealable.has(question.id)) return { recommendation: undefined, visible: false, locked: false, seen, error: undefined };
  const fetched = reveals.fetched[question.id];
  const open = reveals.open[question.id] === true;
  const toggle = (): void => {
    if (answered) return;
    reveals.setOpen(question.id, !open);
    if (!open) reveals.fetch(question.id);
  };
  const visible = fetched !== undefined && (open || answered);
  return { recommendation: visible ? fetched : undefined, visible, locked: answered, seen, error: reveals.failed[question.id] || undefined, ...(reveals.live && { toggle }) };
}

const answerKey = (answer: QuestionAnswer | undefined): string => (isHeldAnswer(answer) ? JSON.stringify(answer) : "");

/**
 * Once answered, the recommendation is fetched so the verdict shows; that answer stays blind. An answer that lands
 * while the recommendation shows is tagged seen, and clearing the answer clears the tag, as the harness's `tagSeen` does.
 */
export function useRevealTracking(question: Question, answer: QuestionAnswer | undefined, visible: boolean): void {
  const reveals = useContext(RevealContext);
  const key = answerKey(answer);
  const before = useRef({ key, visible });
  const revealable = reveals?.revealable.has(question.id) === true;
  const fetch = reveals?.fetch;
  const setSeen = reveals?.setSeen;
  useEffect(() => {
    if (revealable && key !== "") fetch?.(question.id);
  }, [revealable, key, fetch, question.id]);
  useEffect(() => {
    const was = before.current;
    before.current = { key, visible };
    if (!revealable || was.key === key) return;
    setSeen?.(question.id, key !== "" && was.visible);
  }, [revealable, key, visible, setSeen, question.id]);
}

/** The page's answers with each one given while its recommendation showed tagged `recommendationSeen`. */
export function useWithSeen(): (answers: SubmittedAnswer[]) => SubmittedAnswer[] {
  const reveals = useContext(RevealContext);
  const revealable = reveals?.revealable;
  const seen = reveals?.seen;
  return useCallback(
    (answers: SubmittedAnswer[]) => answers.map((answer) => (revealable?.has(answer.questionId) && seen?.[answer.questionId] ? { ...answer, recommendationSeen: true as const } : answer)),
    [revealable, seen],
  );
}

/** The options a shown recommendation picks; none while it is hidden, so a hidden one cannot leak through a badge. */
export function recommendedChoices(shown: ShownRecommendation): string[] {
  const answer = shown.visible ? shown.recommendation?.answer : undefined;
  if (answer === undefined) return [];
  return Array.isArray(answer) ? answer : [String(answer)];
}

function verdictText(question: Question, answer: QuestionAnswer | undefined, recommendation: Recommendation, seen: boolean): string | null {
  if (answer === undefined || !isHeldAnswer(answer)) return null;
  if ("revisionRequested" in answer) return "You asked for a revision";
  if ("text" in answer) return null;
  const verdict = agrees({ questionId: question.id, ...answer }, recommendation) ? "Matches your pick" : "Differs from your pick";
  return seen ? `${verdict} · seen before answering` : verdict;
}

const recommendedText = (answer: Recommendation["answer"]): string => plainText(Array.isArray(answer) ? answer.join(", ") : String(answer));

function RecommendationExtras({ recommendation }: { recommendation: Recommendation }): ReactNode {
  return (
    <>
      {recommendation.weakPoint ? (
        <VStack gap={1}>
          <Typography variant="caption" color="secondary">Weak point</Typography>
          <RoundProse text={recommendation.weakPoint} />
        </VStack>
      ) : null}
      {recommendation.fallback ? <Typography variant="caption">Fallback: <InlineMarkdown text={recommendation.fallback} /></Typography> : null}
    </>
  );
}

/** The recommendation, its confidence and recommender, the verdict against the owner's answer, its weak point and fallback. */
export function RecommendationBox({ question, answer, shown }: { question: Question; answer: QuestionAnswer | undefined; shown: ShownRecommendation }): ReactNode {
  const { recommendation } = shown;
  if (!shown.visible || recommendation === undefined) return null;
  const verdict = verdictText(question, answer, recommendation, shown.seen);
  const matches = verdict?.startsWith("Matches") === true;
  return (
    <Alert status="info" size="compact" message={`Recommended: ${recommendedText(recommendation.answer)} (${Math.round(recommendation.confidence * 100)}%, ${recommendation.by})`} testID={`recommendation-${question.id}`}>
      <VStack gap={2}>
        {verdict ? <Pill variant="subtle" size="xs" tone={matches ? "success" : "warning"} testID={`verdict-${question.id}`}>{verdict}</Pill> : null}
        <RoundProse text={recommendation.rationale} />
        <RecommendationExtras recommendation={recommendation} />
      </VStack>
    </Alert>
  );
}

function revealHelp(shown: ShownRecommendation): string {
  if (shown.locked) return shown.seen ? "You revealed it before answering." : "Shown because you answered.";
  return shown.visible ? "Your answer will be marked as seen." : "Showing it first marks your answer as seen.";
}

/** Off by default so the owner answers blind; `r` presses it on the active question. */
export function RevealControl({ question, shown }: { question: Question; shown: ShownRecommendation }): ReactNode {
  if (shown.toggle === undefined) return null;
  const failure = shown.error ? <Alert status="error" size="compact" message={`Not revealed: ${shown.error}`} /> : null;
  if (shown.locked) return shown.visible ? <Typography variant="caption" color="secondary">{revealHelp(shown)}</Typography> : failure;
  return (
    <VStack gap={1}>
      <HStack gap={2} align="center" wrap>
        <Button variant="outline" size="sm" accessibilityState={{ selected: shown.visible }} onPress={shown.toggle} testID={`reveal-${question.id}`}>
          <ButtonText>{shown.visible ? "Hide recommendation" : "Reveal recommendation (r)"}</ButtonText>
        </Button>
        <Typography variant="caption" color="secondary">{revealHelp(shown)}</Typography>
      </HStack>
      {failure}
    </VStack>
  );
}
