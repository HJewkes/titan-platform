import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractFigures, type ExtractedFigure, type FigureNote } from "./figures.js";
import { isShortQuote, isVerbatim, quoteStates, wordCount } from "./quotes.js";
import { ArticleClaimSchema, ArticleFactSchema, QUOTE_MAX_WORDS, type ArticleClaim, type ArticleFact } from "./schemas.js";

export interface GatherArticleOptions {
  /** The article or paper as text (markdown), extracted from its URL or PDF into a directory of its own. */
  articlePath: string;
  /** The source chip's label, such as the paper's short title. */
  label: string;
  /** Proposed claims and numbers, each with its verbatim quote, from a model pass or a hand edit. */
  claims: readonly unknown[];
  quoteMaxWords?: number;
}

export interface RejectedClaim {
  claim: unknown;
  reason: string;
}

export interface GatherArticleResult {
  facts: ArticleFact[];
  rejected: RejectedClaim[];
  notes: FigureNote[];
}

function rejection(claim: ArticleClaim, text: string, maxWords: number): string | undefined {
  if (!isVerbatim(claim.quote, text)) return "the quote is not verbatim in the article";
  if (!isShortQuote(claim.quote, maxWords)) return `the quote runs ${wordCount(claim.quote)} words; the limit is ${maxWords}`;
  if (claim.kind === "number" && !quoteStates(claim.quote, claim.value!)) return `the quote does not state ${claim.value}`;
  return undefined;
}

function claimFact(claim: ArticleClaim, label: string, ref: string): ArticleFact {
  const { id, kind, text, quote, value, unit } = claim;
  return ArticleFactSchema.parse({ id: `${kind}/${id}`, kind, text, quote, value, unit, source: { label, ref } });
}

function figureFact(figure: ExtractedFigure, label: string, ref: string): ArticleFact {
  return ArticleFactSchema.parse({ id: `figure/${figure.id}`, kind: "figure", text: figure.caption, figure: figure.data, source: { label, ref: `${ref}:${figure.line}` } });
}

/** The validateDecisions pattern: every proposed claim is checked against the text, and a failing one is kept as a rejection with its reason. */
export function checkClaims(claims: readonly unknown[], text: string, maxWords = QUOTE_MAX_WORDS): { accepted: ArticleClaim[]; rejected: RejectedClaim[] } {
  const accepted: ArticleClaim[] = [];
  const rejected: RejectedClaim[] = [];
  for (const claim of claims) {
    const parsed = ArticleClaimSchema.safeParse(claim);
    if (!parsed.success) {
      rejected.push({ claim, reason: `not a claim: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` });
      continue;
    }
    const duplicate = accepted.some((kept) => kept.id === parsed.data.id);
    const reason = duplicate ? `duplicate claim id ${parsed.data.id}` : rejection(parsed.data, text, maxWords);
    if (reason === undefined) accepted.push(parsed.data);
    else rejected.push({ claim, reason });
  }
  return { accepted, rejected };
}

/**
 * The paper-summary profile's facts: claims and numbers whose quotes are verbatim and short, and the data of every
 * captioned figure the text carries as a table, ready to re-plot. Facts sort by id, so two runs write the same file.
 */
export async function gatherArticle(options: GatherArticleOptions): Promise<GatherArticleResult> {
  const text = await readFile(options.articlePath, "utf8");
  const ref = basename(options.articlePath);
  const { accepted, rejected } = checkClaims(options.claims, text, options.quoteMaxWords);
  const { figures, notes } = extractFigures(text);
  const facts = [...accepted.map((claim) => claimFact(claim, options.label, ref)), ...figures.map((figure) => figureFact(figure, options.label, ref))];
  return { facts: facts.sort((a, b) => a.id.localeCompare(b.id)), rejected, notes };
}

export interface ArticleGatherFiles {
  facts: string;
  rejected: string;
}

/** Writes `facts.jsonl`, one fact per line, and `rejected.json` with each refused claim and the notes, into `dir`. */
export async function writeArticleGather(dir: string, result: GatherArticleResult): Promise<ArticleGatherFiles> {
  await mkdir(dir, { recursive: true });
  const files = { facts: join(dir, "facts.jsonl"), rejected: join(dir, "rejected.json") };
  await writeFile(files.facts, result.facts.map((fact) => `${JSON.stringify(fact)}\n`).join(""));
  await writeFile(files.rejected, `${JSON.stringify({ rejected: result.rejected, notes: result.notes }, null, 2)}\n`);
  return files;
}

/** Reads a `facts.jsonl` back; a line that fails the schema throws, naming its line number. */
export function parseArticleFacts(jsonl: string): ArticleFact[] {
  return jsonl
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, n }) => {
      const parsed = ArticleFactSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`facts.jsonl line ${n}: ${parsed.error.message}`);
      return parsed.data;
    });
}
