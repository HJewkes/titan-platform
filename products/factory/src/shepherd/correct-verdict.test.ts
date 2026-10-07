import { DispatchError } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import { correctVerdict, type CorrectTiming, type CorrectVerdictInput } from "./correct-verdict.js";
import type { ReviewerAgent, ReviewerDispatch } from "./review.js";
import { ReviewerBrokerDown } from "./review-wait.js";
import { correctionPrompt } from "./reviewer-brief.js";

const HEAD = "c".repeat(40);
const WRITTEN_AT = 2_000;
const input: CorrectVerdictInput = {
  repo: "octo/demo",
  pr: 7,
  head: HEAD,
  reviewerAgentId: "agent-rv",
  reviewerSessionId: "session-rv",
  dispatchedAt: 1_000,
  malformed: { refusal: "no_block", writtenAt: WRITTEN_AT },
};

const reviewer = (overrides: Partial<ReviewerAgent> = {}): ReviewerAgent => ({
  name: "rv-octo-demo-7",
  agentId: "agent-rv",
  sessionId: "session-rv",
  presence: "exited",
  spawnedBy: null,
  predecessor: null,
  lastWrittenAt: WRITTEN_AT,
  ...overrides,
});

interface Scene {
  rows: ReviewerAgent[];
  /** How the reviewer's row reads once the resume shows on the roster; the default is a running session. */
  resumed?: (row: ReviewerAgent) => Partial<ReviewerAgent>;
  /** The roster shows a resume only this long after it was asked, as the broker's does. */
  showsAfterMs?: number;
  /** Thrown by the first resumes, one each, before they reach the broker. */
  refusals?: Error[];
}

/** A roster in memory over a fake clock; a resume shows on the roster `showsAfterMs` later. */
function fake(scene: Scene) {
  const clock = { now: 50_000 };
  const resumes: { name: string; brief: string }[] = [];
  const refusals = [...(scene.refusals ?? [])];
  let shownAt: number | undefined;
  const dispatch: ReviewerDispatch = {
    roster: async () => scene.rows.map((row) => (shownAt !== undefined && clock.now >= shownAt ? { ...row, ...(scene.resumed?.(row) ?? { presence: "live" }) } : row)),
    spawn: async () => Promise.reject(new Error("a correction never spawns")),
    resume: async (name, brief) => {
      const refusal = refusals.shift();
      if (refusal) throw refusal;
      resumes.push({ name, brief });
      shownAt = clock.now + (scene.showsAfterMs ?? 0);
    },
  };
  const timing: CorrectTiming = { now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: 10, timeoutMs: 1_000, busyWaitMs: 60_000 };
  const run = (overrides: Partial<CorrectVerdictInput> = {}, repeat = false) => correctVerdict(dispatch, { ...input, ...overrides }, timing, new AbortController().signal, repeat);
  return { run, resumes, clock };
}

describe("sh-correct-verdict", () => {
  it("resumes the exited reviewer once with the correction prompt, and answers asked only once the resume shows on the roster", async () => {
    const { run, resumes } = fake({ rows: [reviewer()], showsAfterMs: 100 });

    const result = await run();

    expect(resumes).toEqual([{ name: "rv-octo-demo-7", brief: correctionPrompt({ repo: "octo/demo", pr: 7, head: HEAD, refusal: "no_block" }) }]);
    expect(result).toEqual({ kind: "asked", startedAt: 50_100 });
  });

  it("counts a resume as shown when the session wrote after the malformed message, though the reviewer already exited again", async () => {
    const { run } = fake({ rows: [reviewer()], resumed: () => ({ lastWrittenAt: WRITTEN_AT + 1 }) });

    expect(await run()).toMatchObject({ kind: "asked" });
  });

  it.each<[string, Partial<ReviewerAgent>]>([
    ["live", { presence: "live" }],
    ["detached", { presence: "detached" }],
  ])("resumes no reviewer that is %s on a first run", async (_name, overrides) => {
    const { run, resumes } = fake({ rows: [reviewer(overrides)] });

    expect(await run()).toEqual({ kind: "none", reason: "the reviewer had not exited, so it was not resumed" });
    expect(resumes).toEqual([]);
  });

  it.each<[string, ReviewerAgent[]]>([
    ["no row", []],
    ["two rows with its agent id", [reviewer(), reviewer({ name: "rv-other" })]],
  ])("resumes nobody when the roster holds %s", async (_name, rows) => {
    const { run, resumes } = fake({ rows });

    expect(await run()).toEqual({ kind: "none", reason: "the reviewer is not on the roster exactly once" });
    expect(resumes).toEqual([]);
  });

  it("resumes no reviewer whose row is in another session than the one that wrote the malformed message", async () => {
    const { run, resumes } = fake({ rows: [reviewer({ sessionId: "session-later" })] });

    expect(await run()).toEqual({ kind: "none", reason: "the reviewer's session changed, so it was not resumed" });
    expect(resumes).toEqual([]);
  });

  it("answers none when the resume shows on the roster in another session", async () => {
    const { run, resumes } = fake({ rows: [reviewer()], resumed: () => ({ presence: "live", sessionId: "session-forked" }) });

    expect(await run()).toEqual({ kind: "none", reason: "the resumed reviewer is in another session" });
    expect(resumes).toHaveLength(1);
  });

  it("answers none when the resume never shows on the roster", async () => {
    const { run } = fake({ rows: [reviewer()], resumed: (row) => row });

    expect(await run()).toEqual({ kind: "none", reason: "the resumed reviewer did not show on the roster in time" });
  });

  it("rejects with a refused resume, which the step turns into a refusal", async () => {
    const { run } = fake({ rows: [reviewer()], refusals: [new DispatchError("not resumable")] });

    await expect(run()).rejects.toBeInstanceOf(DispatchError);
  });

  it("waits out a broker that is down and resumes once it is back", async () => {
    const { run, resumes } = fake({ rows: [reviewer()], refusals: [new ReviewerBrokerDown("no socket")] });

    expect(await run()).toMatchObject({ kind: "asked" });
    expect(resumes).toHaveLength(1);
  });

  it.each<[string, Partial<ReviewerAgent>]>([
    ["running", { presence: "live" }],
    ["exited again after writing its reply", { lastWrittenAt: WRITTEN_AT + 5 }],
  ])("on a repeat, asks nothing of a reviewer whose resume already landed (%s)", async (_name, overrides) => {
    const { run, resumes } = fake({ rows: [reviewer(overrides)], resumed: (row) => row });

    expect(await run({}, true)).toMatchObject({ kind: "asked" });
    expect(resumes).toEqual([]);
  });

  it("on a repeat whose resume never landed, resumes the reviewer once", async () => {
    const { run, resumes } = fake({ rows: [reviewer()] });

    expect(await run({}, true)).toMatchObject({ kind: "asked" });
    expect(resumes).toHaveLength(1);
  });

  it("asks for the owner block when the run's verdict goes to the owner", async () => {
    const { run, resumes } = fake({ rows: [reviewer()] });

    await run({ ownerBrief: true });

    expect(resumes[0]?.brief).toContain("OWNER-BRIEF");
  });
});
