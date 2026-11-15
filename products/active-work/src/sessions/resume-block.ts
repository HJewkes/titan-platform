interface ResumeOpenTask {
  id: string;
  title: string;
  priority: number;
}

export interface ResumeBlockInput {
  sessionId: string;
  compactionCount: number;
  /** Oldest first. */
  compactionSummaries: string[];
  branch: string | null;
  worktreePath: string | null;
  filesWritten: { items: string[]; dropped: number };
  openTasks: ResumeOpenTask[];
}

const RESUME_BLOCK_HEADING = '## Resume after compaction';

const NONE = 'none';

function scalar(label: string, value: string | null): string[] {
  return [`- ${label}: ${value === null || value === '' ? NONE : value}`];
}

function list(label: string, rows: string[]): string[] {
  return rows.length === 0 ? [`- ${label}: ${NONE}`] : [`- ${label}:`, ...rows.map((r) => `  - ${r}`)];
}

function filesRows(files: ResumeBlockInput['filesWritten']): string[] {
  if (files.items.length === 0) return [];
  const rows = files.items.map((f) => `\`${f}\``);
  return files.dropped > 0 ? [...rows, `…and ${files.dropped} more`] : rows;
}

function summaryRows(summaries: string[]): string[] {
  return summaries.map((s) => s.replace(/\s*\r?\n\s*/g, ' ').trim());
}

/** One markdown block to re-inject after a compaction; field order is fixed. */
export function renderResumeBlock(input: ResumeBlockInput): string {
  const lines = [
    RESUME_BLOCK_HEADING,
    '',
    ...scalar('Session', input.sessionId),
    ...scalar('Compactions', input.compactionCount > 0 ? String(input.compactionCount) : null),
    ...list('Last compaction summaries', summaryRows(input.compactionSummaries)),
    ...scalar('Branch', input.branch),
    ...scalar('Worktree', input.worktreePath),
    ...list('Files written', filesRows(input.filesWritten)),
    ...list(
      'Open tasks',
      input.openTasks.map((t) => `${t.id} (priority ${t.priority}): ${t.title}`),
    ),
  ];
  return `${lines.join('\n')}\n`;
}
