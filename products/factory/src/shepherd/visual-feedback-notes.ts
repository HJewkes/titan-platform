// TP-5410 (gate model S7): answered `feedback` rounds' notes become tasks. One active-work task per non-blank note, filed
// through the active-work CLI; a ledger of (round id, note index) keys is what makes a re-run file nothing. Rounds are read by
// `readRounds` and an answer counts only if `boundAnswerRefusal` accepts it: the same rules the Ship sweep applies.
import { z } from "zod";
import { RoundFeedbackSchema, boundAnswerRefusal } from "./round-merge.js";
import type { StoredRound } from "./round-ship-sweep.js";

const RoundFile = z.looseObject({
  kind: z.string(),
  questions: z.array(z.looseObject({ id: z.string() })).default([]),
  sections: z.array(z.looseObject({ id: z.string(), changed: z.string().optional(), context: z.string().optional() })).default([]),
  prGroups: z.array(z.looseObject({ pr: z.string(), sectionIds: z.array(z.string()).default([]), task: z.looseObject({ id: z.string() }).optional() })).default([]),
});

type RoundFileData = z.infer<typeof RoundFile>;

export interface NoteTask {
  key: string;
  initiative: string;
  title: string;
  notes: string;
  doneWhen: string;
}

export interface NotesPorts {
  rounds: () => Promise<StoredRound[]>;
  filed: () => Promise<ReadonlySet<string>>;
  /** Files one task, then records its key; a failure throws and records nothing. */
  file: (task: NoteTask) => Promise<void>;
}

export interface NotesResult {
  filed: string[];
  skipped: number;
  failed: { key: string; reason: string }[];
  /** Answered feedback rounds whose answer does not bind to their round.json; nothing of theirs is filed. */
  refused: { round: string; reason: string }[];
}

const TITLE_MAX = 80;
const parseJson = <T>(bytes: Uint8Array, schema: z.ZodType<T>): T | undefined => {
  try {
    return schema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8"))).data;
  } catch {
    return undefined;
  }
};

const titleOf = (note: string): string => {
  const line = note.split("\n")[0]!.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const prefixOf = (taskId: string | undefined): string | undefined => {
  const prefix = taskId?.includes("/") ? taskId.split("/")[0]! : "";
  return /^[A-Za-z0-9][\w.-]*$/.test(prefix) ? prefix : undefined;
};

/** The notes question of one PR is `notes-pr-<n>`; its index among the round's questions is the key's stable part. */
function noteTasks(id: string, round: RoundFileData, texts: ReadonlyMap<string, string>, fallback: string): NoteTask[] {
  return round.questions.flatMap((question, index) => {
    const note = texts.get(question.id)?.trim();
    const match = /^notes-pr-(\d+)$/.exec(question.id);
    const group = match && round.prGroups.find((entry) => entry.pr.endsWith(`#${match[1]}`));
    if (!note || !group) return [];
    const frame = round.sections.find((section) => group.sectionIds.includes(section.id));
    const frameText = [frame?.changed, frame?.context].filter(Boolean).join(" ");
    return [
      {
        key: `${id}#${index}`,
        initiative: prefixOf(group.task?.id) ?? fallback,
        title: titleOf(note),
        notes: `From visual feedback round ${id}, ${group.pr}: ${note}${frameText && `\nFrame: ${frameText}`}`,
        doneWhen: "The note is acted on or dropped with a reason",
      },
    ];
  });
}

type Pending = { tasks: NoteTask[] } | { refused: string };

function pending(stored: StoredRound, fallback: string): Pending {
  const round = parseJson(stored.round, RoundFile);
  if (round?.kind !== "feedback" || stored.feedback === undefined) return { tasks: [] };
  const feedback = parseJson(stored.feedback, RoundFeedbackSchema);
  const reason = feedback ? boundAnswerRefusal(stored.round, feedback) : "feedback.json does not read as round feedback";
  if (!feedback || reason !== undefined) return { refused: reason ?? "" };
  const texts = new Map(feedback.answers.flatMap((answer) => (answer.text === undefined ? [] : [[answer.questionId, answer.text] as const])));
  return { tasks: noteTasks(stored.id, round, texts, fallback) };
}

export async function sweepFeedbackNotes(ports: NotesPorts, fallbackInitiative: string): Promise<NotesResult> {
  const done = new Set(await ports.filed());
  const result: NotesResult = { filed: [], skipped: 0, failed: [], refused: [] };
  for (const stored of await ports.rounds()) {
    const found = pending(stored, fallbackInitiative);
    if ("refused" in found) result.refused.push({ round: stored.id, reason: found.refused });
    else await fileAll(found.tasks, done, ports, result);
  }
  return result;
}

async function fileAll(tasks: readonly NoteTask[], done: Set<string>, ports: NotesPorts, result: NotesResult): Promise<void> {
  for (const task of tasks) {
    if (done.has(task.key)) {
      result.skipped += 1;
      continue;
    }
    try {
      await ports.file(task);
      done.add(task.key);
      result.filed.push(task.key);
    } catch (error) {
      result.failed.push({ key: task.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}
