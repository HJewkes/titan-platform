import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

/** Runs `gh <args>` and returns its stdout; tests pass a fake that answers `pr view` and `pr diff`. */
export type GhRun = (args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const spawnGh: GhRun = async (args) => (await execFileAsync("gh", [...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

export interface PrRef {
  repo: string;
  number: number;
}

const REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** `owner/repo#N`, or undefined when the text is not one. */
export function parsePrRef(text: string): PrRef | undefined {
  const match = REF.exec(text.trim());
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

export const formatPrRef = (ref: PrRef): string => `${ref.repo}#${ref.number}`;

const Note = z.looseObject({ body: z.string().default(""), state: z.string().optional(), submittedAt: z.string().optional(), createdAt: z.string().optional() });

export const PR_VIEW_FIELDS = "number,title,body,headRefName,headRefOid,reviews,comments";

export const PrViewSchema = z.looseObject({
  number: z.number().int(),
  title: z.string(),
  body: z.string().default(""),
  headRefName: z.string().default(""),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/, "expected a full head sha"),
  reviews: z.array(Note).default([]),
  comments: z.array(Note).default([]),
});
export type PrView = z.infer<typeof PrViewSchema>;
export type PrNote = z.infer<typeof Note>;

export interface PrRead {
  view: PrView;
  patch: string;
}

/** The PR's metadata, reviews, comments and patch through two `gh pr` reads. */
export async function readPr(ref: PrRef, gh: GhRun): Promise<PrRead> {
  const target = [String(ref.number), "--repo", ref.repo];
  const [viewText, patch] = await Promise.all([gh(["pr", "view", ...target, "--json", PR_VIEW_FIELDS]), gh(["pr", "diff", ...target])]);
  return { view: PrViewSchema.parse(JSON.parse(viewText)), patch };
}
