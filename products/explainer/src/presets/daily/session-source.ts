import { discoverTranscripts, extractTranscript, type SessionRow } from "@titan-design/session-read";
import type { DigestItem } from "../../digest.js";

export interface DayWindow {
  since: string;
  until: string;
}

type DatedSession = SessionRow & { startedAt: string; endedAt: string };

const inWindow = (row: SessionRow, window: DayWindow): row is DatedSession =>
  row.startedAt !== null && row.endedAt !== null && Date.parse(row.startedAt) < Date.parse(window.until) && Date.parse(row.endedAt) >= Date.parse(window.since);

function sessionItem(row: DatedSession): DigestItem {
  return {
    id: `session/${row.sessionId}`,
    kind: "session",
    title: row.aiTitle ?? "untitled session",
    at: row.startedAt,
    summary: `${row.turnDelta} turns, ${row.commitDelta} commits, ${row.pushDelta} pushes`,
  };
}

/**
 * One item per top-level session active in the window, over every root, keyed by its session id. Subagent sidechains carry their
 * parent's id, so they are left out rather than folded into the parent twice.
 */
export async function sessionItems(transcriptRoots: readonly string[], window: DayWindow): Promise<DigestItem[]> {
  const discovered = (await Promise.all(transcriptRoots.map((root) => discoverTranscripts(root)))).flat();
  const transcripts = discovered.filter((transcript) => transcript.subagentId === null);
  const rows = new Map<string, DatedSession>();
  for (const transcript of transcripts) {
    for (const row of (await extractTranscript(transcript.absolutePath)).sessions) {
      if (inWindow(row, window)) rows.set(row.sessionId, row);
    }
  }
  return [...rows.values()].map(sessionItem);
}
