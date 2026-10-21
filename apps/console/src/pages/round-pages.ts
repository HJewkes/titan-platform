import type { Question, Section } from "../../server/round-schema.js";

/** One page of a paged round: a section, or the questions no section claims. */
export interface SectionPage {
  id: string;
  title: string;
  questions: Question[];
}

/** The page of the questions no section claims; `~` is outside the schema's id alphabet, so no section id collides. */
const OTHER_PAGE = "~other";

export const pageIdOf = (section: Section | null): string => section?.id ?? OTHER_PAGE;

/** The page of the frames no section shows, last, as the check screen lists their verdicts. */
export const OTHER_FRAMES_PAGE = "~frames";
const OTHER_FRAMES: SectionPage = { id: OTHER_FRAMES_PAGE, title: "Other frames", questions: [] };

/** One page per group of `orderedQuestions`, in its order, then an "Other frames" page when some frame has no section. */
export function sectionPages(groups: readonly { section: Section | null; questions: Question[] }[], otherFrames = false): SectionPage[] {
  const pages = groups.map(({ section, questions }) => ({ id: pageIdOf(section), title: section?.title ?? "Other questions", questions }));
  return otherFrames ? [...pages, OTHER_FRAMES] : pages;
}

/** A round with neither sections nor questions still has a page to stand on. */
const EMPTY_PAGE: SectionPage = { id: OTHER_PAGE, title: "Other questions", questions: [] };

/** The page `?section=` names; a missing or unknown one opens the first. */
export function pageAt(pages: readonly SectionPage[], query: string | undefined): { index: number; page: SectionPage } {
  const id = new URLSearchParams(query ?? "").get("section");
  const index = Math.max(0, pages.findIndex((page) => page.id === id));
  return { index, page: pages[index] ?? EMPTY_PAGE };
}

/** `query` with `section` set to `id`, keeping any other parameter. */
export function withSection(query: string | undefined, id: string): string {
  const params = new URLSearchParams(query ?? "");
  params.set("section", id);
  return params.toString();
}

/** What the jump list says of a page, from the questions still open across the round. */
export function pageMark(page: SectionPage, open: readonly Question[]): string {
  const total = page.questions.length;
  if (total === 0) return "no questions";
  const answered = page.questions.filter((question) => !open.includes(question)).length;
  if (answered === total) return "answered";
  return answered === 0 ? "unanswered" : `${answered} of ${total} answered`;
}
