import { parseHeader, splitTitle } from "./header.js";
import type { ChapterMeta } from "./types.js";

/**
 * How one corpus names and orders its documents. Another corpus supplies its own;
 * the indexer only ever sees `describe`.
 */
export interface CorpusLayout {
  readonly name: string;
  /** Undefined means the file is not a document of this corpus, and is skipped. */
  describe(relPath: string, text: string): ChapterMeta | undefined;
}

/** Serial reading order of the series; one not listed sorts after these, by name. */
const SERIES_RANK: Readonly<Record<string, number>> = { "player-manager": 0, "soccer-supremo": 1, dof: 2 };
const UNRANKED = Object.keys(SERIES_RANK).length;

const CHAPTER_PATH = /^([^/]+)\/book_(\d+)\/chapter_(\d+)(?:_preseason_(\d+))?\.txt$/;
const OTHER_PATH = /^other\/([^/]+)\.txt$/;

function chapterId(series: string, book: number, chapter: number, preseason: number | undefined): string {
  return `${series}/${book}/${chapter}${preseason === undefined ? "" : `p${preseason}`}`;
}

function headerMeta(text: string): { code?: string; title: string; published?: string; postId?: string } {
  const { fields } = parseHeader(text);
  const { code, title } = splitTitle(fields.TITLE ?? "");
  return { code, title, published: fields.PUBLISHED, postId: fields.POST_ID };
}

function describeChapter(match: RegExpExecArray, relPath: string, text: string): ChapterMeta {
  const series = match[1]!;
  const [book, chapter] = [Number(match[2]), Number(match[3])];
  const preseason = match[4] === undefined ? undefined : Number(match[4]);
  const id = chapterId(series, book, chapter, preseason);
  const header = headerMeta(text);
  // Preseason posts are numbered chapter 0, so they fall before chapter 1 and among themselves by number.
  const order = [0, SERIES_RANK[series] ?? UNRANKED, series, book, chapter, preseason ?? 0];
  return { id, relPath, ref: header.code ?? id, title: header.title, series, book, chapter, preseason, published: header.published, postId: header.postId, order };
}

function describeOther(match: RegExpExecArray, relPath: string, text: string): ChapterMeta {
  const header = headerMeta(text);
  const slug = match[1]!;
  const published = header.published ?? /^\d{4}-\d{2}-\d{2}/.exec(slug)?.[0] ?? "";
  const id = `other/${slug}`;
  // Interludes sit after the numbered series, in the order they were published.
  return { id, relPath, ref: header.code ?? id, title: header.title, series: "other", published: published || undefined, postId: header.postId, order: [1, published, relPath] };
}

/** `<series>/book_NN/chapter_KK[_preseason_N].txt` plus `other/<date>_<slug>.txt`, each with a TITLE/PUBLISHED/POST_ID header. */
export const archiveLayout: CorpusLayout = {
  name: "archive",
  describe(relPath, text) {
    const other = OTHER_PATH.exec(relPath);
    if (other) return describeOther(other, relPath, text);
    const chapter = CHAPTER_PATH.exec(relPath);
    return chapter ? describeChapter(chapter, relPath, text) : undefined;
  },
};

/** One `.txt` file is one document, ordered by path; header lines are used when present. */
export const plainLayout: CorpusLayout = {
  name: "plain",
  describe(relPath, text) {
    if (!relPath.endsWith(".txt")) return undefined;
    const header = headerMeta(text);
    const series = relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : "";
    return { id: relPath, relPath, ref: header.code ?? relPath, title: header.title, series, published: header.published, postId: header.postId, order: [relPath] };
  },
};

export const LAYOUTS: Readonly<Record<string, CorpusLayout>> = { archive: archiveLayout, plain: plainLayout };
