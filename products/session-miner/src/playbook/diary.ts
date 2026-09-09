import type { SessionGraph } from "@titan-design/session-graph";
import { RELATIONS, sessionRef } from "@titan-design/session-read";

/**
 * The Generator stage, and it never calls a model. Everything below is read
 * straight out of the session subgraph the miner already built, so the same
 * session always yields the same diary and the write path stays reproducible.
 */
export interface ErrorSignature {
  templateId: string;
  partition: string;
  signature: string;
  count: number;
  /** Jump-to-evidence for the first occurrence in this session. */
  byteOffset: number;
}

export interface SessionOutcome {
  status: "success" | "failure" | "mixed";
  prsMerged: number;
  prsAbandoned: number;
  tasksDone: number;
  tasksOpen: number;
  errorCount: number;
  distinctErrors: number;
}

export interface SessionDiary {
  sessionRef: string;
  title: string | null;
  startedAt: string | null;
  branch: string | null;
  turnCount: number;
  commitCount: number;
  filesTouched: string[];
  tasks: { ref: string; status: string | null; title: string | null }[];
  prs: { ref: string; state: string | null; mergedAt: string | null; title: string | null }[];
  subagents: number;
  errors: ErrorSignature[];
  outcome: SessionOutcome;
  /** First byte of the session in its transcript: the provenance anchor. */
  byteOffset: number | undefined;
}

const MAX_FILES = 40;
const MAX_ERRORS = 12;

export function buildDiary(graph: SessionGraph, sessionId: string): SessionDiary | undefined {
  const row = graph.db.prepare("SELECT * FROM session WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const ref = sessionRef(sessionId);
  const edges = graph.edges.from(ref);
  const targets = (relation: string) => edges.filter((e) => e.relation === relation).map((e) => e.targetRef);
  const tasks = lookupTasks(graph, targets(RELATIONS.RAN));
  const prs = lookupPrs(graph, targets(RELATIONS.LINKED));
  const errors = errorSignatures(graph, sessionId);
  return {
    sessionRef: ref,
    title: (row.ai_title as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    branch: (row.git_branch as string | null) ?? null,
    turnCount: (row.turn_count as number) ?? 0,
    commitCount: (row.commit_count as number) ?? 0,
    filesTouched: targets(RELATIONS.TOUCHED).slice(0, MAX_FILES),
    tasks,
    prs,
    subagents: targets(RELATIONS.SPAWNED).length,
    errors,
    outcome: classifyOutcome(prs, tasks, errors),
    byteOffset: firstByteOffset(graph, sessionId),
  };
}

function firstByteOffset(graph: SessionGraph, sessionId: string): number | undefined {
  const row = graph.db.prepare("SELECT MIN(byte_offset) AS offset FROM fact WHERE session_id = ?").get(sessionId) as { offset: number | null } | undefined;
  return row?.offset ?? undefined;
}

function lookupTasks(graph: SessionGraph, refs: string[]): SessionDiary["tasks"] {
  const get = graph.db.prepare("SELECT task_ref, status, title FROM task WHERE task_ref = ?");
  return refs.map((ref) => {
    const row = get.get(ref) as { status: string | null; title: string | null } | undefined;
    return { ref, status: row?.status ?? null, title: row?.title ?? null };
  });
}

function lookupPrs(graph: SessionGraph, refs: string[]): SessionDiary["prs"] {
  const get = graph.db.prepare("SELECT state, merged_at, title FROM pr WHERE pr_ref = ?");
  return refs.map((ref) => {
    const row = get.get(ref) as { state: string | null; merged_at: string | null; title: string | null } | undefined;
    return { ref, state: row?.state ?? null, mergedAt: row?.merged_at ?? null, title: row?.title ?? null };
  });
}

function errorSignatures(graph: SessionGraph, sessionId: string): ErrorSignature[] {
  const rows = graph.db
    .prepare(
      `SELECT o.template_id AS templateId, t.partition, t.masked_signature AS signature,
              COUNT(*) AS count, MIN(o.byte_offset) AS byteOffset
         FROM occurrence o JOIN template t ON t.template_id = o.template_id
        WHERE o.session_id = ?
        GROUP BY o.template_id
        ORDER BY count DESC, templateId
        LIMIT ?`,
    )
    .all(sessionId, MAX_ERRORS) as ErrorSignature[];
  return rows;
}

/**
 * Hard labels, not self-report: a merged PR or a closed task is success, an
 * abandoned PR or errors with nothing shipped is failure. cass-memory asks a
 * model for this; the graph already knows.
 */
export function classifyOutcome(prs: SessionDiary["prs"], tasks: SessionDiary["tasks"], errors: ErrorSignature[]): SessionOutcome {
  const prsMerged = prs.filter((p) => p.mergedAt !== null || p.state === "MERGED").length;
  const prsAbandoned = prs.filter((p) => p.mergedAt === null && p.state === "CLOSED").length;
  const tasksDone = tasks.filter((t) => t.status === "done").length;
  const tasksOpen = tasks.filter((t) => t.status !== null && t.status !== "done").length;
  const errorCount = errors.reduce((sum, e) => sum + e.count, 0);
  const shipped = prsMerged > 0 || tasksDone > 0;
  const stumbled = prsAbandoned > 0 || errorCount > 0;
  const status = shipped && !stumbled ? "success" : shipped || !stumbled ? "mixed" : "failure";
  return { status, prsMerged, prsAbandoned, tasksDone, tasksOpen, errorCount, distinctErrors: errors.length };
}

/** The diary as the prose a reflector reads. Deterministic, so it is also a fine `--dry-run` output. */
export function renderDiary(diary: SessionDiary): string {
  const lines = [
    `# Session ${diary.sessionRef}`,
    diary.title ? `Title: ${diary.title}` : null,
    `Started: ${diary.startedAt ?? "unknown"} | Branch: ${diary.branch ?? "unknown"} | Turns: ${diary.turnCount} | Commits: ${diary.commitCount}`,
    `Outcome: ${diary.outcome.status} (merged ${diary.outcome.prsMerged}, abandoned ${diary.outcome.prsAbandoned}, tasks done ${diary.outcome.tasksDone}, errors ${diary.outcome.errorCount})`,
    section("Tasks", diary.tasks.map((t) => `${t.ref} [${t.status ?? "unknown"}] ${t.title ?? ""}`.trim())),
    section("Pull requests", diary.prs.map((p) => `${p.ref} [${p.state ?? "unknown"}] ${p.title ?? ""}`.trim())),
    section("Files touched", diary.filesTouched),
    section("Recurring errors", diary.errors.map((e) => `(${e.count}x, ${e.partition}) ${e.signature}`)),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

function section(heading: string, items: string[]): string | null {
  return items.length === 0 ? null : `\n## ${heading}\n${items.map((i) => `- ${i}`).join("\n")}`;
}
