import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { replace, useRoute } from "../router.js";
import { submittedAnswers, unanswered } from "./RoundAnswers.js";
import type { SendCheck } from "./RoundCheck.js";
import { choicesOf } from "./RoundQuestion.js";
import { RoundSections, orderedQuestions, type RoundAnswers, type RoundSectionsProps } from "./RoundSections.js";
import { pageAt, pageMark, sectionPages, withSection, type SectionPage } from "./round-pages.js";
import { typedInto } from "./typed-into.js";

/**
 * A round's sections one page at a time (owner decision 513): Back, Next, a jump list and `?section=` in the URL, so
 * a reload or a link keeps the page. The send controls close the last page. A round of one section is one page, as before.
 */
export function PagedSections({ send, check, checking, ...sections }: RoundSectionsProps & PagedSendProps): ReactNode {
  const pages = useMemo(() => sectionPages(orderedQuestions(sections.manifest)), [sections.manifest]);
  const paging = useSectionPaging(pages, sections.state, !checking);
  const endRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const { page, open } = paging;
  useFocusWhenDone(page.id, page.questions.length > 0 && page.questions.every((question) => !open.includes(question)), endRef);
  useScrollOnPageChange(page.id, topRef);
  useLanding(pages, paging, check, sections.state.setActiveId);
  if (checking) return send;
  if (pages.length < 2) return <><RoundSections {...sections} />{send}</>;
  const last = paging.index === pages.length - 1;
  return (
    <>
      <div ref={topRef} className="scroll-mt-4" data-section={page.id}>
        <VStack gap={2} testID="section-pager">
          <PagerSteps pages={pages} paging={paging} />
          <JumpList pages={pages} paging={paging} open={open} />
        </VStack>
      </div>
      <RoundSections {...sections} page={page.id} />
      <div ref={endRef}>
        <PagerSteps pages={pages} paging={paging} end />
      </div>
      {last ? send : null}
    </>
  );
}

interface PagedSendProps {
  /** The send card, or the check screen when `checking`, which then stands in for every page. */
  send: ReactNode;
  check: SendCheck;
  checking: boolean;
}

const submittedOf = (questions: readonly Question[], { answers, comments, optionNotes }: RoundAnswers) => submittedAnswers(questions, answers, comments, optionNotes);

/** The page `?section=` names, a step to another, and the questions still open across the round. */
function useSectionPaging(pages: readonly SectionPage[], state: RoundAnswers, keys: boolean) {
  const { view, id, query } = useRoute();
  const { index, page } = pageAt(pages, query);
  const go = useCallback(
    (to: number) => {
      const target = pages[to];
      if (target) replace({ view, id, query: withSection(query, target.id) });
    },
    [pages, view, id, query],
  );
  const step = useCallback((delta: number) => go(index + delta), [go, index]);
  usePageKeys(keys && pages.length > 1, step);
  useActiveOnPage(page, state);
  const all = pages.flatMap((each) => each.questions);
  return { index, page, go, step, open: unanswered(all, submittedOf(all, state)) };
}

type Paging = ReturnType<typeof useSectionPaging>;

/**
 * Digit keys answer the active question, so a page that opens without it hands them to its own first choice, or to none.
 * A frame pressed on this page keeps the keys until the page turns.
 */
function useActiveOnPage(page: SectionPage, { activeId, setActiveId, frames }: RoundAnswers): void {
  const shown = useRef(page.id);
  useEffect(() => {
    const turned = shown.current !== page.id;
    shown.current = page.id;
    if (page.questions.some((question) => question.id === activeId)) return;
    if (!turned && frames.activeFrame !== undefined) return;
    const first = page.questions.find((question) => choicesOf(question).length > 0)?.id;
    // Setting what is already set would still land after a frame press queued in the same tick, and undo it.
    if (first !== activeId || frames.activeFrame !== undefined) setActiveId(first);
  }, [page, activeId, setActiveId, frames.activeFrame]);
}

/** `n` and `p` step through the sections; `[` and `]` already step through the set, digits answer. */
function usePageKeys(enabled: boolean, step: (delta: number) => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typedInto(event.target)) return;
      const delta = event.key === "n" ? 1 : event.key === "p" ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      step(delta);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, step]);
}

/**
 * Once the page's last open question takes an answer, focus goes to Next, so finishing a section never reads as
 * finishing the round. Typing keeps its focus: a text answer is "answered" from its first letter.
 */
function useFocusWhenDone(pageId: string, done: boolean, end: RefObject<HTMLDivElement | null>): void {
  const seen = useRef({ pageId, done });
  useEffect(() => {
    const before = seen.current;
    seen.current = { pageId, done };
    if (before.pageId === pageId && !before.done && done && !typedInto(document.activeElement)) end.current?.querySelector<HTMLElement>('[data-testid="section-next-end"]')?.focus();
  }, [pageId, done, end]);
}

/** A new page mounts below wherever the owner had scrolled to, so bring its top up; the first draw stays put. */
function useScrollOnPageChange(pageId: string, top: RefObject<HTMLDivElement | null>): void {
  const shown = useRef(pageId);
  useEffect(() => {
    if (shown.current === pageId) return;
    shown.current = pageId;
    top.current?.scrollIntoView({ block: "start" });
  }, [pageId, top]);
}

/**
 * A step from the check screen opens its question's page, then brings the question into view: digit keys answer a
 * question with choices, and a text question's answer box takes focus.
 */
function useLanding(pages: readonly SectionPage[], { index, go }: Paging, { landOn, landed }: SendCheck, setActiveId: (id: string) => void): void {
  useEffect(() => {
    if (landOn === undefined) return;
    const at = pages.findIndex((page) => page.questions.some((question) => question.id === landOn));
    const question = pages[at]?.questions.find((each) => each.id === landOn);
    if (question && choicesOf(question).length > 0) setActiveId(landOn);
    if (at >= 0 && at !== index) return go(at);
    const entry = document.querySelector<HTMLElement>(`[data-testid="round-entry-${landOn}"]`);
    entry?.scrollIntoView({ block: "center" });
    if (question && choicesOf(question).length === 0) entry?.querySelector<HTMLElement>("textarea, input")?.focus({ preventScroll: true });
    landed();
  }, [pages, index, go, landOn, landed, setActiveId]);
}

interface PagerStepsProps {
  pages: readonly SectionPage[];
  paging: Paging;
  /** The closing row, whose Next is where focus goes when the section is done. */
  end?: boolean;
}

/** Back, where the owner is, and Next; an end of the round keeps its button, disabled, so the row does not shift. */
function PagerSteps({ pages, paging: { index, page, step }, end = false }: PagerStepsProps): ReactNode {
  const next = pages[index + 1];
  return (
    <HStack gap={3} align="center" wrap testID={end ? "section-pager-end" : "section-steps"}>
      <Button size="sm" variant="outline" isDisabled={index === 0} onPress={() => step(-1)}><ButtonText>← Back</ButtonText></Button>
      <Typography variant={end ? "caption" : "subtitle2"} color={end ? "secondary" : undefined} testID={end ? undefined : "section-position"}>
        {`Section ${index + 1} of ${pages.length}: ${page.title}`}
      </Typography>
      <Button size="sm" variant={end && next ? "solid" : "outline"} isDisabled={next === undefined} onPress={() => step(1)} testID={end ? "section-next-end" : "section-next"}><ButtonText>Next →</ButtonText></Button>
      {end ? null : <KeyHint />}
    </HStack>
  );
}

/** A phone has no keyboard to press, so the hint shows from `md` up. */
function KeyHint(): ReactNode {
  return (
    <span className="hidden md:inline">
      <Typography variant="caption" color="secondary">n and p step through the sections</Typography>
    </span>
  );
}

/** Every section by title, the current one solid, each saying how much of it is answered. */
function JumpList({ pages, paging: { index, go }, open }: { pages: readonly SectionPage[]; paging: Paging; open: readonly Question[] }): ReactNode {
  return (
    <nav aria-label="Sections" data-testid="section-jump-list">
      <HStack gap={2} wrap>
        {pages.map((page, at) => {
          const mark = pageMark(page, open);
          return (
            <Button key={page.id} size="sm" variant={at === index ? "solid" : "ghost"} color="secondary" onPress={() => go(at)} testID={`section-jump-${page.id}`}>
              <ButtonText>{`${mark === "answered" ? "✓ " : ""}${at + 1}. ${page.title} · ${mark}`}</ButtonText>
            </Button>
          );
        })}
      </HStack>
    </nav>
  );
}
