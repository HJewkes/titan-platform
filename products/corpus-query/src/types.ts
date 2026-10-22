import { z } from "zod";

/** Position of a document in reading order; compared element by element. */
export type StoryOrderKey = readonly (number | string)[];

export const ChapterMetaSchema = z.object({
  /** Stable owner id for the document's spans, unique within a corpus. */
  id: z.string(),
  /** Path relative to the corpus root, always with forward slashes. */
  relPath: z.string(),
  /** What a reader cites: the header's title code, or the id when the file has none. */
  ref: z.string(),
  title: z.string(),
  series: z.string(),
  book: z.number().optional(),
  chapter: z.number().optional(),
  preseason: z.number().optional(),
  published: z.string().optional(),
  postId: z.string().optional(),
  order: z.array(z.union([z.number(), z.string()])),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;

/** A run of consecutive paragraphs of one document. Holds locators only, never text. */
export interface Passage {
  id: string;
  chapterId: string;
  ref: string;
  firstParagraph: number;
  lastParagraph: number;
  fileSha8: string;
}

export const QuerySpecSchema = z.object({
  entity: z.string().min(1),
  rowFields: z.array(z.enum(["entity", "subject", "period", "detail"])),
  /** AND of ORs: a paragraph matches when it holds one term from every group. Prefix terms end in `*`. */
  termGroups: z.array(z.array(z.string().min(1)).min(1)),
  phrases: z.array(z.string().min(1)),
  seedLexicon: z.array(z.string().min(1)),
  mode: z.enum(["broad", "phrase"]),
  inclusion: z.array(z.string()),
  exclusion: z.array(z.string()),
  canaries: z.array(z.object({ text: z.string().min(1), expect: z.enum(["match", "no-match"]) })),
});

export type QuerySpec = z.infer<typeof QuerySpecSchema>;
