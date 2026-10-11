/** Where a Claude Code auto-memory fact file came from; `host` marks a read-only mirror of another machine. */
export interface MemorySourceRef {
  account: string;
  project: string;
  path: string;
  host?: string;
}

export const MEMORY_FACT_TYPES = ["user", "feedback", "project", "reference", "unknown"] as const;
export type MemoryFactType = (typeof MEMORY_FACT_TYPES)[number];

export interface ParsedFact {
  ok: true;
  ref: MemorySourceRef;
  name: string;
  description: string;
  type: MemoryFactType;
  body: string;
  modified?: string;
  /** `contentKey(description + "\n" + body)`: case- and whitespace-insensitive. */
  contentHash: string;
}

export interface ParseFailure {
  ok: false;
  ref: MemorySourceRef;
  error: string;
}

/** One `- [Title](file.md) — hook` line of a `MEMORY.md` index; `line` is 1-based. */
export interface MemoryIndexPointer {
  file: string;
  title: string;
  line: number;
}

/** A fact and every file that says the same thing; `fact` is the representative. */
export interface DedupedFact {
  fact: ParsedFact;
  sources: ParsedFact[];
}

export interface FactGroup {
  label: string;
  facts: DedupedFact[];
}

export interface SkillSummary {
  name: string;
  description: string;
}

export type MemoryDestination = `skill:${string}` | `new-skill:${string}` | "charter" | `claude-md:${string}` | "delete";

export interface DestinationProposal {
  destination: MemoryDestination;
  reason: string;
}
