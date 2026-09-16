import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TranscriptHead } from "../corpus/transcripts.js";
import { transcriptId } from "../corpus/transcripts.js";
import type { EvalPair, LinkMethod } from "../pairs.js";
import { listOfMaps, readFrontmatter, scalarField } from "./frontmatter.js";
import { labelsFrom } from "./spawn-arm.js";

/**
 * The bootstrap arm: what a deterministic retrieval step at session start
 * would have to beat.
 *
 * The query is one session's open loops — the ledger a wrap leaves behind. The
 * labels are what the NEXT canonical session on that initiative opened, which
 * is the work those loops turned into.
 */

export interface SessionRecord {
  file: string;
  initiative: string;
  /** Frontmatter `session_id`: a transcript uuid, a `session_01…` harness id, or a slug. */
  sessionId?: string;
  track?: string;
  loops: string[];
}

/** Sidecar and fork records are not the thread a next-session query follows. */
function isCanonical(record: SessionRecord): boolean {
  return record.track === undefined || record.track === "canonical";
}

export function readSessionRecord(file: string, initiative: string): SessionRecord {
  const frontmatter = readFrontmatter(readFileSync(file, "utf8"));
  if (frontmatter === undefined) return { file, initiative, loops: [] };
  const loops = listOfMaps(frontmatter, "next_steps")
    .map((entry) => entry.text ?? "")
    .filter((text) => text.trim().length > 0);
  const sessionId = scalarField(frontmatter, "session_id");
  const track = scalarField(frontmatter, "track");
  return { file, initiative, ...(sessionId ? { sessionId } : {}), ...(track ? { track } : {}), loops };
}

/** Every `<root>/<slug>/sessions` plus every archived initiative's, which is real data too. */
export function sessionDirs(activeRoot: string): { initiative: string; dir: string }[] {
  const dirs: { initiative: string; dir: string }[] = [];
  const push = (initiative: string, dir: string) => {
    if (existsSync(dir)) dirs.push({ initiative, dir });
  };
  for (const entry of readdirSync(activeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "archive") {
      const archive = path.join(activeRoot, "archive");
      for (const old of readdirSync(archive, { withFileTypes: true })) {
        if (old.isDirectory()) push(old.name, path.join(archive, old.name, "sessions"));
      }
      continue;
    }
    push(entry.name, path.join(activeRoot, entry.name, "sessions"));
  }
  return dirs;
}

/** Filenames lead with `YYYY-MM-DD-HHMM`, so lexical order is chronological order. */
export function readInitiative(initiative: string, dir: string): SessionRecord[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => readSessionRecord(path.join(dir, file), initiative));
}

/**
 * Resolve a session record to the transcript it was written from.
 *
 * Two routes, because the corpus holds two id shapes. A uuid `session_id` names
 * a transcript file directly. A `session_01…` id does not, but Claude Code
 * stamps the session's own web url into the transcript, so the id can be read
 * back out of it. Records whose `session_id` is a hand-written slug pre-date
 * transcript ids entirely and are unresolvable by design, not by failure.
 */
export function resolveTranscript(
  record: SessionRecord,
  byUuid: Map<string, string>,
  byHarnessId: Map<string, string>,
): { transcript: string; method: LinkMethod } | undefined {
  const id = record.sessionId;
  if (id === undefined) return undefined;
  const direct = byUuid.get(id);
  if (direct) return { transcript: direct, method: "session-id" };
  const viaHarness = byHarnessId.get(id);
  return viaHarness ? { transcript: viaHarness, method: "harness-id" } : undefined;
}

export function indexHeads(heads: TranscriptHead[]): {
  byUuid: Map<string, string>;
  byHarnessId: Map<string, string>;
} {
  const byUuid = new Map<string, string>();
  const byHarnessId = new Map<string, string>();
  for (const head of heads) {
    byUuid.set(transcriptId(head.file), head.file);
    if (head.harnessSessionId && !byHarnessId.has(head.harnessSessionId)) {
      byHarnessId.set(head.harnessSessionId, head.file);
    }
  }
  return { byUuid, byHarnessId };
}

/** One session's loops joined into the query a bootstrap step would issue. */
export function loopQuery(loops: string[]): string {
  return loops.join("\n\n");
}

export interface BootstrapMining {
  pairs: EvalPair[];
  pairsConsidered: number;
  linked: number;
  unlinked: number;
  byMethod: Record<string, number>;
}

export async function mineBootstrapArm(activeRoot: string, heads: TranscriptHead[]): Promise<BootstrapMining> {
  const { byUuid, byHarnessId } = indexHeads(heads);
  const pairs: EvalPair[] = [];
  const byMethod: Record<string, number> = {};
  let considered = 0;
  let linked = 0;
  for (const { initiative, dir } of sessionDirs(activeRoot)) {
    const canonical = readInitiative(initiative, dir).filter(isCanonical);
    for (let i = 0; i < canonical.length - 1; i++) {
      const current = canonical[i]!;
      if (current.loops.length === 0) continue;
      considered++;
      const link = resolveTranscript(canonical[i + 1]!, byUuid, byHarnessId);
      if (link === undefined) continue;
      linked++;
      byMethod[link.method] = (byMethod[link.method] ?? 0) + 1;
      const labels = await labelsFrom(link.transcript, activeRoot);
      if (labels.length === 0) continue;
      pairs.push(bootstrapPair(current, link, labels));
    }
  }
  return { pairs, pairsConsidered: considered, linked, unlinked: considered - linked, byMethod };
}

function bootstrapPair(
  current: SessionRecord,
  link: { transcript: string; method: LinkMethod },
  labels: EvalPair["labels"],
): EvalPair {
  return {
    arm: "bootstrap",
    id: `bootstrap:${current.initiative}:${path.basename(current.file, ".md")}`,
    query: loopQuery(current.loops),
    labels,
    provenance: {
      sessionFile: current.file,
      labelTranscript: link.transcript,
      linkedBy: link.method,
      initiative: current.initiative,
    },
  };
}
