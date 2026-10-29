import { parseFrontMatter } from "./header.js";
import type { CorpusLayout } from "./layout.js";
import type { ChapterMeta } from "./types.js";

const ANCHOR = /^\[(\d{1,3}):([0-5]\d)\]/;

/** Seconds into the video from a paragraph's leading `[mm:ss]`; undefined when it has none. */
export function paragraphAnchor(paragraph: string): number | undefined {
  const match = ANCHOR.exec(paragraph);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** Longer suffixes first, so `.score.json` is never read as a transcript. */
const KINDS = [
  { suffix: ".score.json", kind: "score", rank: 1 },
  { suffix: ".digest.md", kind: "digest", rank: 2 },
  { suffix: ".md", kind: "transcript", rank: 0 },
] as const;

/** `<handle>/<id>.md` transcripts with their `.score.json` and `.digest.md` siblings, all citing the video id. */
export const youtubeLayout: CorpusLayout = {
  name: "youtube",
  describe(relPath, text): ChapterMeta | undefined {
    const kind = KINDS.find((k) => relPath.endsWith(k.suffix));
    if (!kind) return undefined;
    const file = relPath.slice(relPath.lastIndexOf("/") + 1, -kind.suffix.length);
    const { fields } = parseFrontMatter(text);
    const ref = fields.id || file;
    const id = kind.kind === "transcript" ? ref : `${ref}.${kind.kind}`;
    const series = relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : (fields.channel ?? "");
    const published = fields.posted || undefined;
    return { id, relPath, ref, title: fields.title ?? "", series, published, order: [series, published ?? "", ref, kind.rank] };
  },
};
