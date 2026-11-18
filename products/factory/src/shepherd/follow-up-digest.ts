import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FOLLOW_UP_SEVERITIES } from "@titan-design/review-panel";
import { z } from "zod";

/** Owner decision (TP-6714): a low follow-up waits in the weekly digest for a month, then drops unless someone made it a task. */
const RETENTION_MS = 28 * 86_400_000;

const DigestEntrySchema = z.object({
  title: z.string(),
  severity: z.enum(FOLLOW_UP_SEVERITIES),
  done_when: z.string(),
  from_pr: z.string(),
  from_task: z.string(),
  head: z.string(),
  reviewer: z.string(),
});

/** One follow-up kept out of the task list, in the same field names a filed follow-up task carries. */
export type DigestEntry = z.infer<typeof DigestEntrySchema>;

/** `promoted` names the task a reader filed from the row; a promoted row outlives the retention window. */
const DigestRowSchema = DigestEntrySchema.extend({ at: z.iso.datetime(), promoted: z.string().optional() });
type DigestRow = z.infer<typeof DigestRowSchema>;

/** Where follow-ups below the task bar go instead of active-work's task list. */
export interface FollowUpDigest {
  append(initiative: string, entries: readonly DigestEntry[]): Promise<void>;
}

/** Written straight into the initiative's sources, next to the other weekly records the owner reads. */
export function followUpDigestPath(activeRoot: string, initiative: string): string {
  return join(activeRoot, initiative, "sources", "follow-up-digest.jsonl");
}

function parsedRows(text: string): DigestRow[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const row = DigestRowSchema.safeParse(JSON.parse(line));
      return row.success ? [row.data] : [];
    } catch {
      return [];
    }
  });
}

async function readRows(path: string): Promise<DigestRow[]> {
  try {
    return parsedRows(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function kept(row: DigestRow, nowMs: number): boolean {
  return row.promoted !== undefined || nowMs - Date.parse(row.at) <= RETENTION_MS;
}

/** Each write prunes the file, so the digest never holds an unpromoted row past the window it was written in plus one write. */
export function fileFollowUpDigest(activeRoot: string, now: () => number): FollowUpDigest {
  return {
    async append(initiative, entries) {
      const path = followUpDigestPath(activeRoot, initiative);
      const nowMs = now();
      const at = new Date(nowMs).toISOString();
      const rows = [...(await readRows(path)).filter((row) => kept(row, nowMs)), ...entries.map((entry) => ({ ...entry, at }))];
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temp, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    },
  };
}
