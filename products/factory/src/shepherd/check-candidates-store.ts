import type { RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/**
 * The findings reviewers say a check could have caught (TP-6482, B2). A row is data and gates nothing: the weekly
 * aggregate reads it to propose checks, and a MERGE after FIX_FIRSTs confirms the rows of the answered rounds.
 */
const MemberSchema = z.object({ shape: z.string(), agentId: z.string(), verdict: z.enum(["MERGE", "FIX_FIRST"]) });
type CandidateMember = z.infer<typeof MemberSchema>;

/** One reviewer's line of a `Check-candidates:` block at one head. */
export interface CandidateInput {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  classKey: string;
  route: string;
  sketch: string;
  area: string | null;
  member: CandidateMember;
  locator: string;
}

interface CheckCandidate {
  runId: string;
  repo: string;
  pr: number;
  head: string;
  classKey: string;
  route: string;
  sketch: string;
  area: string | null;
  /** FIX_FIRST when any member blocked on the class at this head. */
  verdict: CandidateMember["verdict"];
  members: CandidateMember[];
  locators: string[];
  /** Null until the run merges after answering the FIX_FIRST that raised it. */
  confirmed: boolean | null;
  at: string;
}

const CANDIDATES_DDL = `
  CREATE TABLE check_candidates (
    run_id    TEXT NOT NULL,
    repo      TEXT NOT NULL,
    pr        INTEGER NOT NULL,
    head      TEXT NOT NULL,
    class_key TEXT NOT NULL,
    route     TEXT NOT NULL,
    sketch    TEXT NOT NULL,
    area      TEXT,
    verdict   TEXT NOT NULL,
    members   TEXT NOT NULL,
    locators  TEXT NOT NULL,
    confirmed INTEGER,
    at        TEXT NOT NULL,
    UNIQUE (repo, pr, head, class_key)
  );
  CREATE INDEX check_candidates_at ON check_candidates (at);`;

export function checkCandidatesMigration(version = 54): Migration {
  return { version, name: "factory:shepherd_check_candidates", up: (db) => db.exec(CANDIDATES_DDL) };
}

export interface CheckCandidates {
  /** Upserts on (repo, pr, head, class key): a member or locator already on the row is not added again. */
  record(rows: readonly CandidateInput[]): void;
  /** Sets confirmed on the PR's rows at these heads only; returns how many rows it marked. */
  confirm(repo: RepoSlug, pr: number, heads: readonly string[]): number;
  /** Rows recorded at or after `date` (ISO), oldest first. */
  since(date: string): CheckCandidate[];
}

const jsonText = <T extends z.ZodType>(schema: T) =>
  z.string().transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  }).pipe(schema);

const StoredCandidate = z.object({
  run_id: z.string(), repo: z.string(), pr: z.number().int(), head: z.string(), class_key: z.string(), route: z.string(), sketch: z.string(),
  area: z.string().nullable(), verdict: MemberSchema.shape.verdict, members: jsonText(z.array(MemberSchema)), locators: jsonText(z.array(z.string())),
  confirmed: z.number().int().nullable(), at: z.string(),
});

/** A row whose JSON cannot be read is skipped, so one bad row never stops the aggregate. */
function fromRow(raw: unknown): CheckCandidate[] {
  const parsed = StoredCandidate.safeParse(raw);
  if (!parsed.success) return [];
  const { run_id: runId, class_key: classKey, confirmed, ...rest } = parsed.data;
  return [{ ...rest, runId, classKey, confirmed: confirmed === null ? null : confirmed === 1 }];
}

const sameMember = (a: CandidateMember, b: CandidateMember): boolean => a.shape === b.shape && a.agentId === b.agentId;

/** A re-recorded member keeps its place and takes its latest verdict. */
function mergeMembers(members: readonly CandidateMember[], next: CandidateMember): CandidateMember[] {
  return members.some((member) => sameMember(member, next)) ? members.map((member) => (sameMember(member, next) ? next : member)) : [...members, next];
}

const verdictOf = (members: readonly CandidateMember[]): CandidateMember["verdict"] => (members.some((member) => member.verdict === "FIX_FIRST") ? "FIX_FIRST" : "MERGE");

const UPSERT = `INSERT INTO check_candidates (run_id, repo, pr, head, class_key, route, sketch, area, verdict, members, locators, confirmed, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  ON CONFLICT (repo, pr, head, class_key) DO UPDATE SET run_id = excluded.run_id, verdict = excluded.verdict, members = excluded.members, locators = excluded.locators, at = excluded.at`;

function recordOne(db: Db, input: CandidateInput, at: string): void {
  const repo = input.repo.toLowerCase();
  const existing = fromRow(db.prepare("SELECT * FROM check_candidates WHERE repo = ? AND pr = ? AND head = ? AND class_key = ?").get(repo, input.pr, input.head, input.classKey))[0];
  const members = mergeMembers(existing?.members ?? [], input.member);
  const locators = [...new Set([...(existing?.locators ?? []), input.locator])];
  db.prepare(UPSERT).run(input.runId, repo, input.pr, input.head, input.classKey, input.route, input.sketch, input.area, verdictOf(members), JSON.stringify(members), JSON.stringify(locators), at);
}

export function checkCandidatesTable(db: Db, stamp: () => string): CheckCandidates {
  return {
    record: (rows) => {
      const at = stamp();
      db.transaction(() => rows.forEach((row) => recordOne(db, row, at)))();
    },
    confirm: (repo, pr, heads) => {
      if (heads.length === 0) return 0;
      const marks = heads.map(() => "?").join(", ");
      return db.prepare(`UPDATE check_candidates SET confirmed = 1 WHERE repo = ? AND pr = ? AND head IN (${marks})`).run(repo.toLowerCase(), pr, ...heads).changes;
    },
    since: (date) => db.prepare("SELECT * FROM check_candidates WHERE at >= ? ORDER BY at, repo, pr, head, class_key").all(date).flatMap(fromRow),
  };
}
