import { describe, expect, it } from "vitest";
import { sweepFeedbackNotes, type NoteTask, type NotesPorts } from "./visual-feedback-notes.js";

const feedbackRound = {
  kind: "feedback",
  questions: [{ id: "notes-pr-7" }, { id: "notes-pr-9" }, { id: "notes-pr-12" }],
  sections: [{ id: "pr-7", changed: "1 visual path(s) changed: a.css.", context: "Merged." }, { id: "pr-9" }, { id: "pr-12" }],
  prGroups: [
    { pr: "sample/repo#7", sectionIds: ["pr-7"], task: { id: "sample-init/T-1" } },
    { pr: "sample/repo#9", sectionIds: ["pr-9"] },
    { pr: "sample/repo#12", sectionIds: ["pr-12"] },
  ],
};
const bound = { unit: "vf-a-1-2026-W45", round: 1, manifestSha256: "0".repeat(64), submittedAt: "2026-11-10T00:00:00.000Z" };
const answers = { ...bound, answers: [{ questionId: "notes-pr-7", text: "Tighten the badge\nmore detail" }, { questionId: "notes-pr-9", text: "   " }, { questionId: "notes-pr-12", text: "Dark mode border" }] };

function world(files: Record<string, unknown>) {
  const filed = new Set<string>();
  const tasks: NoteTask[] = [];
  const ports: NotesPorts = {
    roundIds: async () => [...new Set(Object.keys(files).map((key) => key.split("/")[0]!))],
    read: async (id, file) => (files[`${id}/${file}`] === undefined ? undefined : JSON.stringify(files[`${id}/${file}`])),
    filed: async () => filed,
    file: async (task) => {
      tasks.push(task);
      filed.add(task.key);
    },
  };
  return { ports, tasks };
}

describe("the feedback notes sweep", () => {
  it("files one task per non-blank note of an answered round, citing the round and PR", async () => {
    const { ports, tasks } = world({ "vf-a-1-2026-W45/round.json": feedbackRound, "vf-a-1-2026-W45/feedback.json": answers });

    const result = await sweepFeedbackNotes(ports, "fallback-init");

    expect(result.filed).toEqual(["vf-a-1-2026-W45#0", "vf-a-1-2026-W45#2"]);
    expect(tasks.map((task) => [task.initiative, task.title])).toEqual([["sample-init", "Tighten the badge"], ["fallback-init", "Dark mode border"]]);
    expect(tasks[0]!.notes).toContain("vf-a-1-2026-W45, sample/repo#7");
    expect(tasks[0]!.notes).toContain("1 visual path(s) changed");
  });

  it("files nothing on a re-run", async () => {
    const { ports, tasks } = world({ "vf-a-1-2026-W45/round.json": feedbackRound, "vf-a-1-2026-W45/feedback.json": answers });
    await sweepFeedbackNotes(ports, "x");

    const again = await sweepFeedbackNotes(ports, "x");

    expect(again).toMatchObject({ filed: [], skipped: 2 });
    expect(tasks).toHaveLength(2);
  });

  it("files nothing for an unanswered round", async () => {
    const { ports, tasks } = world({ "vf-a-1-2026-W45/round.json": feedbackRound });

    await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
  });

  it("files nothing for a feedback.json with no submit binding", async () => {
    const { ports, tasks } = world({ "vf-a-1-2026-W45/round.json": feedbackRound, "vf-a-1-2026-W45/feedback.json": { answers: answers.answers } });

    await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
  });

  it("ignores a round that is not of kind feedback", async () => {
    const { ports, tasks } = world({ "r1/round.json": { ...feedbackRound, kind: "design" }, "r1/feedback.json": { ...answers, unit: "r1" } });

    await sweepFeedbackNotes(ports, "x");

    expect(tasks).toHaveLength(0);
  });

  it("records a failed filing and leaves it to the next run", async () => {
    const { ports } = world({ "r1/round.json": feedbackRound, "r1/feedback.json": { ...answers, unit: "r1" } });
    ports.file = async () => {
      throw new Error("boom");
    };

    const result = await sweepFeedbackNotes(ports, "x");

    expect(result.failed.map((entry) => entry.key)).toEqual(["r1#0", "r1#2"]);
  });
});
