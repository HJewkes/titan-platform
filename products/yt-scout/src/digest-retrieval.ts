import { z } from "zod";
import type { ScoreCard } from "./score-card.js";

export interface TaskRef {
  id: string;
  title: string;
}

export interface Retrieval {
  priorDigests: string[];
  tasks: TaskRef[];
}

/** Runs a CLI and resolves with its stdout. The real one wraps `execFile`; tests pass a fake. */
export type Exec = (file: string, args: string[]) => Promise<string>;

export type Retriever = (card: ScoreCard) => Promise<Retrieval>;

const TOP = 5;
const STOP = new Set(["about", "which", "their", "there", "using", "should", "would", "where", "these", "those", "after", "before"]);

/** The longest distinctive word of a sentence: corpus-query matches a phrase, and a whole sentence rarely recurs. */
export function keyword(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [];
  return words.filter((w) => !STOP.has(w)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

interface CliRetrieverConfig {
  exec: Exec;
  corpusRoot: string;
  corpusBin?: string;
  activeWorkBin?: string;
}

async function quietly(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch {
    return "";
  }
}

async function priorDigests(config: CliRetrieverConfig, card: ScoreCard): Promise<string[]> {
  const seen = new Set<string>();
  for (const t of card.techniques) {
    const word = keyword(t.what);
    if (!word) continue;
    const out = await quietly(() => config.exec(config.corpusBin ?? "corpus-query", ["hits", config.corpusRoot, "--phrase", word, "--window", "1"]));
    for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) seen.add(line);
  }
  return [...seen].slice(0, TOP);
}

const SearchOutputSchema = z.object({
  hits: z.array(z.object({ ref: z.string().nullish(), class: z.string().nullish(), title: z.string().nullish() })).default([]),
});

function parseTasks(stdout: string): TaskRef[] {
  try {
    const { hits } = SearchOutputSchema.parse(JSON.parse(stdout));
    return hits
      .filter((h) => h.class === "tasks" && h.ref && h.title)
      .map((h) => ({ id: h.ref!.replace(/^task:/, ""), title: h.title! }));
  } catch {
    return [];
  }
}

async function existingTasks(config: CliRetrieverConfig, card: ScoreCard): Promise<TaskRef[]> {
  const words = [...new Set(card.techniques.map((t) => keyword(t.what)).filter((w): w is string => w !== undefined))];
  if (words.length === 0) return [];
  const out = await quietly(() => config.exec(config.activeWorkBin ?? "active-work", ["search", words.join(" "), "--limit", "20"]));
  return parseTasks(out).slice(0, TOP);
}

/** Retrieval degrades to empty lists when a CLI is missing or fails: a digest without context beats no digest. */
export function cliRetriever(config: CliRetrieverConfig): Retriever {
  return async (card) => ({ priorDigests: await priorDigests(config, card), tasks: await existingTasks(config, card) });
}
