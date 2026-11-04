import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { runCleanup } from "./cleanup.js";
import { shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { CleanupTasks, TaskClose, TaskSlicing } from "./ports.js";
import { holdSlotsMigration, lastSliceMigration } from "./store-migrations.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, ShepherdStore, sliceMigration, type RegistrationInput } from "./store.js";

const REPO = "octo/demo";
const RUN = "run-1";
const base: RegistrationInput = { repo: REPO, pr: 1, runId: RUN, task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY };
const LANDING = `${REPO}#1 at ${fakeSha("merge")}`;

function fakeTasks(slicing: TaskSlicing): CleanupTasks & { closed: string[]; notes: string[] } {
  const closed: string[] = [];
  const notes: string[] = [];
  return {
    closed,
    notes,
    state: async () => "open",
    slicing: async () => ({ ...slicing, notes: [slicing.notes, ...notes].join("\n") }),
    done: async (_, id) => void closed.push(id),
    reopen: async () => undefined,
    appendNote: async (_, __, line) => void (notes.includes(line) || notes.push(line)),
  };
}

async function settle(registration: Partial<RegistrationInput>, slicing: TaskSlicing, taskClose?: TaskClose) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), lastSliceMigration(43)]);
  const store = new ShepherdStore(db, () => 0);
  store.register({ ...base, ...registration });
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headRef: "feat/x", headRepo: REPO, headSha: fakeSha("head"), state: "closed", merged: true, mergeSha: fakeSha("merge") });
  fake.refs.set("feat/x", fakeSha("head"));
  const tasks = fakeTasks(slicing);
  const cleanup = { agents: { invalidate: () => undefined, roster: async () => [], retire: async () => undefined }, tasks };
  const deps = { port: githubPort(fake.wire), store: { get: () => store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined, cleanup, ...(taskClose && { taskClose }) };
  const settled = await runCleanup(deps, { repo: REPO, pr: 1, runId: RUN }, new AbortController().signal);
  return { settled, tasks };
}

const planOf = (...names: string[]): string => `# Plan\n\n\`\`\`burndown-slices\n${JSON.stringify(names.map((n) => ({ n, title: `slice ${n}`, points: 1, doneWhen: "a test passes", owns: [`src/${n}.ts`] })))}\n\`\`\`\n`;
const landed = (n: string): string => `${n} landed in demo/x#9 at ${fakeSha(`old-${n}`)}`;

describe("a task its slices do not finish", () => {
  const finishedBlock: TaskSlicing = { tags: ["factory"], notes: ["Close on the test plus the operator task, not on this PR alone.", landed("a"), landed("b")].join("\n"), plan: planOf("a", "b") };

  it("stays open on a follow-up slice after every block slice merged, naming what holds it", async () => {
    const { settled, tasks } = await settle({ slice: "e" }, finishedBlock);

    expect(settled.task).toBe("noted");
    expect(tasks.closed).toEqual([]);
    expect(tasks.notes).toEqual([`e landed in ${LANDING}`, "e merged; task left open: every slice had landed before this PR, so only --last-slice closes it"]);
  });

  it("stays open when a block slice lands a second time", async () => {
    const { settled, tasks } = await settle({ slice: "b" }, finishedBlock);

    expect(settled.task).toBe("noted");
    expect(tasks.closed).toEqual([]);
  });

  it("closes on the slice that completes the block, and on the replay of that landing", async () => {
    const replayed: TaskSlicing = { ...finishedBlock, notes: [landed("a"), `b landed in ${LANDING}`].join("\n") };

    const { settled, tasks } = await settle({ slice: "b" }, replayed);

    expect(settled.task).toBe("done");
    expect(tasks.closed).toEqual(["TP-1"]);
  });

  it("closes on --last-slice once every block slice merged", async () => {
    const { settled, tasks } = await settle({ slice: "e", lastSlice: true }, finishedBlock);

    expect(settled.task).toBe("done");
    expect(tasks.closed).toEqual(["TP-1"]);
  });

  it("closes on a --last-slice PR that names no slice once every block slice merged", async () => {
    const { settled, tasks } = await settle({ lastSlice: true }, finishedBlock);

    expect(settled.task).toBe("done");
    expect(tasks.closed).toEqual(["TP-1"]);
  });
});

describe("a task tagged hold:<reason>", () => {
  const held = (notes: string, plan: string | undefined): TaskSlicing => ({ tags: ["factory", "hold:smoke-pending"], notes, plan });

  it("stays open when the slice that completes its block merges", async () => {
    const { settled, tasks } = await settle({ slice: "b" }, held(landed("a"), planOf("a", "b")));

    expect(settled.task).toBe("noted");
    expect(tasks.closed).toEqual([]);
    expect(tasks.notes.at(-1)).toBe("b merged; task left open: it is tagged hold:smoke-pending");
  });

  it.each([
    ["an unsliced PR", {}, undefined],
    ["a --last-slice PR", { lastSlice: true }, undefined],
    ["a --last-slice PR in last-slice-only mode", { lastSlice: true }, "last-slice-only" as const],
  ])("stays open when %s merges", async (_, registration, taskClose) => {
    const { settled, tasks } = await settle(registration, held("", undefined), taskClose);

    expect(settled.task).toBe("left-open");
    expect(tasks.closed).toEqual([]);
    expect(tasks.notes).toEqual([`PR ${LANDING} merged; task left open: it is tagged hold:smoke-pending`]);
  });
});
