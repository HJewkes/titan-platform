// TP-5410 (gate model S7): answered `feedback` rounds' notes become tasks. One active-work task per non-blank note, filed
// through the active-work CLI; a ledger of (round id, note index) keys is what makes a re-run file nothing.
import { z } from "zod";

const RoundFile = z.looseObject({
  kind: z.string(),
  questions: z.array(z.looseObject({ id: z.string() })).default([]),
  sections: z.array(z.looseObject({ id: z.string(), changed: z.string().optional(), context: z.string().optional() })).default([]),
  prGroups: z.array(z.looseObject({ pr: z.string(), sectionIds: z.array(z.string()).default([]), task: z.looseObject({ id: z.string() }).optional() })).default([]),
});
const AnswersFile = z.looseObject({ answers: z.array(z.looseObject({ questionId: z.string(), text: z.string().optional() })) });

export type RoundFileData = z.infer<typeof RoundFile>;

export interface NoteTask {
  key: string;
  initiative: string;
  title: string;
  notes: string;
  doneWhen: string;
}

export interface NotesPorts {
  /** Round ids under the console's rounds dir. */
  roundIds: () => Promise<string[]>;
  /** The round.json and feedback.json texts; undefined when absent (an unanswered round has no feedback.json). */
  read: (id: string, file: "round.json" | "feedback.json") => Promise<string | undefined>;
  filed: () => Promise<ReadonlySet<string>>;
  /** Files one task, then records its key; a failure throws and records nothing. */
  file: (task: NoteTask) => Promise<void>;
}

export interface NotesResult {
  filed: string[];
  skipped: number;
  failed: { key: string; reason: string }[];
}

const TITLE_MAX = 80;
const parse = <T>(text: string | undefined, schema: z.ZodType<T>): T | undefined => {
  if (text === undefined) return undefined;
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
};

const titleOf = (note: string): string => {
  const line = note.split("\n")[0]!.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

/** The task's initiative is the `<initiative>/<id>` prefix of the PR's task, else the fallback. */
const initiativeOf = (taskId: string | undefined, fallback: string): string => (taskId?.includes("/") ? taskId.split("/")[0]! : fallback);

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
        initiative: initiativeOf(group.task?.id, fallback),
        title: titleOf(note),
        notes: `From visual feedback round ${id}, ${group.pr}: ${note}${frameText && `\nFrame: ${frameText}`}`,
        doneWhen: "The note is acted on or dropped with a reason",
      },
    ];
  });
}

async function pending(id: string, ports: NotesPorts, fallback: string): Promise<NoteTask[]> {
  const round = parse(await ports.read(id, "round.json"), RoundFile);
  if (round?.kind !== "feedback") return [];
  const answers = parse(await ports.read(id, "feedback.json"), AnswersFile);
  if (!answers) return [];
  const texts = new Map(answers.answers.flatMap((answer) => (answer.text === undefined ? [] : [[answer.questionId, answer.text] as const])));
  return noteTasks(id, round, texts, fallback);
}

export async function sweepFeedbackNotes(ports: NotesPorts, fallbackInitiative: string): Promise<NotesResult> {
  const done = new Set(await ports.filed());
  const result: NotesResult = { filed: [], skipped: 0, failed: [] };
  for (const id of await ports.roundIds()) {
    for (const task of await pending(id, ports, fallbackInitiative)) {
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
  return result;
}
