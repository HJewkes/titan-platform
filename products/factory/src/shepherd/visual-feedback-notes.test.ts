import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRounds } from "./round-ship-sweep.js";
import { sweepFeedbackNotes, type NoteTask, type NotesPorts } from "./visual-feedback-notes.js";

const UNIT = "vf-sample-1a2b3c-2026-W45";
const DIR = `${UNIT}-r1`;
const manifest = {
  kind: "feedback",
  unit: UNIT,
  round: 1,
  questions: [{ id: "notes-pr-7" }, { id: "notes-pr-9" }, { id: "notes-pr-12" }],
  sections: [{ id: "pr-7", changed: "1 visual path(s) changed: a.css.", context: "Merged." }, { id: "pr-9" }, { id: "pr-12" }],
  prGroups: [
    { pr: "sample/repo#7", sectionIds: ["pr-7"], task: { id: "sample-init/T-1" } },
    { pr: "sample/repo#9", sectionIds: ["pr-9"] },
    { pr: "sample/repo#12", sectionIds: ["pr-12"] },
  ],
};
const answerList = [{ questionId: "notes-pr-7", text: "Tighten the badge\nmore detail" }, { questionId: "notes-pr-9", text: "   " }, { questionId: "notes-pr-12", text: "Dark mode border" }];

let root: string;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A round as the console imports it: a `<unit>-r<round>` directory, and a feedback.json bound to round.json's bytes. */
async function putRound(opts: { dir?: string; round?: object; feedback?: object | null } = {}): Promise<void> {
  const dir = join(root, opts.dir ?? DIR);
  const roundText = JSON.stringify(opts.round ?? manifest);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "round.json"), roundText);
  if (opts.feedback === null) return;
  const bound = { unit: UNIT, round: 1, manifestSha256: sha(roundText), submittedAt: "2026-11-10T00:00:00.000Z", answers: answerList };
  await writeFile(join(dir, "feedback.json"), JSON.stringify({ ...bound, ...opts.feedback }));
}

function world() {
  const filed = new Set<string>();
  const tasks: NoteTask[] = [];
  const ports: NotesPorts = {
    rounds: () => readRounds(root),
    filed: async () => filed,
    file: async (task) => {
      tasks.push(task);
      filed.add(task.key);
    },
  };
  return { ports, tasks };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "notes-sweep-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the feedback notes sweep", () => {
  it("files one task per non-blank note of an answered round, citing the round and PR", async () => {
    await putRound();
    const { ports, tasks } = world();

    const result = await sweepFeedbackNotes(ports, "fallback-init");

    expect(result.filed).toEqual([`${DIR}#0`, `${DIR}#2`]);
    expect(tasks.map((task) => [task.initiative, task.title])).toEqual([["sample-init", "Tighten the badge"], ["fallback-init", "Dark mode border"]]);
    expect(tasks[0]!.notes).toContain(`${DIR}, sample/repo#7`);
    expect(tasks[0]!.notes).toContain("1 visual path(s) changed");
  });

  it("files nothing on a re-run", async () => {
    await putRound();
    const { ports, tasks } = world();
    await sweepFeedbackNotes(ports, "x");

    const again = await sweepFeedbackNotes(ports, "x");

    expect(again).toMatchObject({ filed: [], skipped: 2 });
    expect(tasks).toHaveLength(2);
  });

  it("files nothing for an unanswered round", async () => {
    await putRound({ feedback: null });
    const { ports, tasks } = world();

    await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
  });

  it("ignores a round that is not of kind feedback", async () => {
    await putRound({ round: { ...manifest, kind: "design" } });
    const { ports, tasks } = world();

    const result = await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
    expect(result.refused).toEqual([]);
  });

  it.each([
    ["a manifest hash that is not round.json's", { manifestSha256: "0".repeat(64) }],
    ["another round number", { round: 999 }],
    ["another unit", { unit: "vf-other-000000-2026-W45" }],
    ["no submit binding", { unit: undefined, round: undefined, manifestSha256: undefined, submittedAt: undefined }],
  ])("refuses and reports an answer with %s", async (_name, feedback) => {
    await putRound({ feedback });
    const { ports, tasks } = world();

    const result = await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
    expect(result.refused.map((entry) => entry.round)).toEqual([DIR]);
  });

  it("files nothing from a symlinked feedback.json", async () => {
    await putRound({ feedback: null });
    await writeFile(join(root, "elsewhere.json"), "{}");
    await symlink(join(root, "elsewhere.json"), join(root, DIR, "feedback.json"));
    const { ports, tasks } = world();

    await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
  });

  it("records a failed filing and leaves it to the next run", async () => {
    await putRound();
    const { ports } = world();
    ports.file = async () => {
      throw new Error("boom");
    };

    const result = await sweepFeedbackNotes(ports, "x");

    expect(result.failed.map((entry) => entry.key)).toEqual([`${DIR}#0`, `${DIR}#2`]);
  });
});
