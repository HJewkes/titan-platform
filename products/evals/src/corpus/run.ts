import { existsSync } from "node:fs";
import { join } from "node:path";
import { transcriptCost, type CostOf } from "./cost.js";
import { extractCorpus, type CorpusRow } from "./extract.js";
import { openFactoryDb } from "./factory-db.js";
import { readFactoryFacts, type FactoryFacts } from "./factory-facts.js";
import { gitClone, type GitPort } from "./git.js";
import type { CorpusLabel } from "./labels.js";

export interface CorpusOptions {
  dbPath: string;
  /** `owner/repo` (case-insensitive) to a local clone. */
  clones: ReadonlyMap<string, string>;
  /** Falls back to `<reposRoot>/<repo name>` for a repo with no explicit clone. */
  reposRoot?: string;
  mainRef?: string;
  now?: Date;
  costOf?: CostOf;
}

function cloneDir(options: CorpusOptions, repo: string): string | undefined {
  const explicit = [...options.clones].find(([name]) => name.toLowerCase() === repo.toLowerCase())?.[1];
  if (explicit) return explicit;
  const name = repo.split("/")[1];
  const guess = options.reposRoot && name ? join(options.reposRoot, name) : undefined;
  return guess && existsSync(join(guess, ".git")) ? guess : undefined;
}

function gitResolver(options: CorpusOptions): (repo: string) => GitPort | undefined {
  const ports = new Map<string, GitPort | undefined>();
  return (repo) => {
    const key = repo.toLowerCase();
    if (!ports.has(key)) {
      const dir = cloneDir(options, repo);
      ports.set(key, dir ? gitClone(dir, options.mainRef) : undefined);
    }
    return ports.get(key);
  };
}

function readFacts(dbPath: string): FactoryFacts {
  const reader = openFactoryDb(dbPath);
  try {
    return readFactoryFacts(reader);
  } finally {
    reader.close();
  }
}

/** Reads the factory database through a `mode=ro` connection, closed before git and transcripts are read. */
export async function buildCorpus(options: CorpusOptions): Promise<CorpusRow[]> {
  return extractCorpus({ facts: readFacts(options.dbPath), gitFor: gitResolver(options), costOf: options.costOf ?? transcriptCost, now: options.now ?? new Date() });
}

export function labelHistogram(rows: readonly CorpusRow[]): Record<CorpusLabel, number> {
  const histogram: Record<CorpusLabel, number> = { escaped: 0, caught: 0, "false-block": 0, clean: 0, pending: 0, unresolved: 0 };
  for (const row of rows) histogram[row.label] += 1;
  return histogram;
}
