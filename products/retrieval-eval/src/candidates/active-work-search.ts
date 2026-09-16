import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ScoredHit } from "../metrics.js";
import type { Candidate } from "./candidate.js";

const run = promisify(execFile);

/**
 * The shipped per-class RRF search, driven as a subprocess.
 *
 * Deliberately the installed binary rather than an in-process import: the
 * daemon runs the installed one, so that is the retrieval a real session would
 * have got. Measuring the repo would measure something nobody is using.
 */

interface SearchHit {
  ref?: string;
  path?: string;
  class?: string;
  excerpt?: string;
}

interface SearchResponse {
  ok?: boolean;
  data?: { hits?: SearchHit[] };
}

export interface ActiveWorkSearchOptions {
  activeRoot: string;
  binary?: string;
  /** Per-query ceiling; a hung subprocess must not stall a 600-query run. */
  timeoutMs?: number;
}

export function activeWorkSearch(options: ActiveWorkSearchOptions): Candidate {
  const binary = options.binary ?? "active-work";
  const timeout = options.timeoutMs ?? 30_000;
  return {
    name: "active-work-search",
    async search(query, limit) {
      if (query.trim().length === 0) return [];
      const args = ["search", query, "--limit", String(limit), "--json"];
      const { stdout } = await run(binary, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
      return hitsOf(stdout, options.activeRoot);
    },
    close() {},
  };
}

/**
 * A malformed or failed response yields no hits rather than throwing.
 *
 * The runner scores hundreds of queries; one that trips the CLI should cost its
 * own row, not the run. A zero row is visible in the output, an exception is not.
 */
export function hitsOf(stdout: string, activeRoot: string): ScoredHit[] {
  let parsed: SearchResponse;
  try {
    parsed = JSON.parse(stdout) as SearchResponse;
  } catch {
    return [];
  }
  return (parsed.data?.hits ?? []).map((hit) => ({
    id: hit.ref ?? hit.path ?? "",
    aliases: aliasesOf(hit, activeRoot),
    chars: (hit.excerpt ?? "").length,
  }));
}

function aliasesOf(hit: SearchHit, activeRoot: string): string[] {
  const aliases: string[] = [];
  if (hit.path) aliases.push(hit.path, path.join(activeRoot, hit.path));
  if (hit.ref) aliases.push(hit.ref);
  return aliases;
}
