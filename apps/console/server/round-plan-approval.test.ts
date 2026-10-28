import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand } from "@titan-design/registry";
import { createRoundListeners, type RoundListeners } from "./listeners.js";
import type { ConsoleContext } from "./owner-guard.js";
import { settledListeners } from "./round-fixtures.js";
import { APPROVE, CI_SCOPE, REVISE, PLAN_REPO, PLAN_ROUND, PLAN_TASK, SKILL_SCOPE, fakeFactory, planBindings, planRound, planWorld, plantFeedback, recordFiles, type FakeFactory, type PlanWorld } from "./round-plan-approval.test-helpers.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import { RoundSchema } from "./round-schema.js";
import type { ShepherdSource } from "./shepherd.js";

const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };
const NO_SHEPHERD: Pick<ShepherdSource, "list"> = { list: async () => [] };

let world: PlanWorld;
let factory: FakeFactory;

beforeEach(async () => {
  world = await planWorld();
  factory = fakeFactory(world.actionsDir);
});

afterEach(async () => {
  await world.remove();
});

function listeners(): RoundListeners {
  return createRoundListeners({
    enabled: false,
    roundsDir: world.roundsDir,
    shepherd: NO_SHEPHERD,
    answer: { post: async () => ({ status: "unreachable", detail: "unused" }) },
    planApproval: { actionsDir: world.actionsDir, client: factory.client },
    now: () => new Date("2026-10-28T12:00:00.000Z"),
  });
}

/** The owner's own submit through the owner-write command, then the listener it started. */
async function submit(answers: { questionId: string; pick: string }[], inner: RoundListeners = listeners()) {
  const settling = settledListeners(inner);
  const outcome = await invokeCommand(roundsSubmitCommands({ dir: world.roundsDir }, undefined, settling)["rounds.submit"], { id: PLAN_ROUND, manifestSha256: world.manifestSha256, answers }, OWNER);
  await settling.settled();
  return outcome;
}

const outcomeOf = async (file: string) => JSON.parse(await readFile(path.join(world.actionsDir, file.replace(/\.json$/, ".outcome.json")), "utf8"));

describe("a plan round's approval answer", () => {
  it("writes one ci-policy plan-approval record with the round id and posts it once to the console-action route", async () => {
    await submit([{ questionId: "ci", pick: APPROVE.ci }]);

    const [file, ...rest] = await recordFiles(world.actionsDir);
    expect(rest).toEqual([]);
    expect(factory.rows).toEqual([{ kind: "plan-approval", task: PLAN_TASK, repo: PLAN_REPO, round: PLAN_ROUND, gate: "ci-policy", scope: CI_SCOPE }]);
    expect(factory.posts).toEqual([file!.replace(/\.json$/, "")]);
    expect(await outcomeOf(file!)).toMatchObject({ status: "plan-approved", task: PLAN_TASK, gate: "ci-policy" });
  });

  it("writes a skill approval with its exact paths as scope", async () => {
    await submit([{ questionId: "skill", pick: APPROVE.skill }]);

    expect(factory.rows).toEqual([{ kind: "plan-approval", task: PLAN_TASK, repo: PLAN_REPO, round: PLAN_ROUND, gate: "skill", scope: SKILL_SCOPE }]);
  });

  it("writes nothing for a pick other than the approve option", async () => {
    await submit([{ questionId: "ci", pick: REVISE.ci }]);

    expect([await recordFiles(world.actionsDir), factory.posts]).toEqual([[], []]);
  });

  it("refuses a replayed answer and a second answer to the same round: still one record and one row", async () => {
    await submit([{ questionId: "ci", pick: APPROVE.ci }]);

    const replay = await submit([{ questionId: "ci", pick: APPROVE.ci }]);
    const second = await submit([{ questionId: "ci", pick: APPROVE.ci }, { questionId: "skill", pick: APPROVE.skill }]);
    await listeners().sweep();

    expect([replay, second].map((each) => each.envelope)).toMatchObject([{ ok: true, data: { status: "already-submitted" } }, { ok: true, data: { status: "already-submitted" } }]);
    expect([(await recordFiles(world.actionsDir)).length, factory.posts.length, factory.rows.length]).toEqual([1, 1, 1]);
  });

  it("refuses a relayed or decided answer no owner submit wrote: the sweep writes and posts nothing", async () => {
    await plantFeedback(world, APPROVE.ci);

    await listeners().sweep();

    expect([await recordFiles(world.actionsDir), factory.posts]).toEqual([[], []]);
  });

  it("reposts a record the owner's submit wrote while the factory was down, once, from the sweep", async () => {
    factory.down = true;
    await submit([{ questionId: "ci", pick: APPROVE.ci }]);
    factory.down = false;

    await listeners().sweep();
    await listeners().sweep();

    expect([factory.posts.length, factory.rows.length]).toEqual([2, 1]);
  });

  it("writes nothing when round.json changed after the owner answered", async () => {
    const inner = listeners();
    const editing: RoundListeners = {
      afterRoundSubmit: async (roundId, result) => {
        const edited = { ...planRound(), unit: "plan-orbit-edited" };
        await writeFile(path.join(world.roundsDir, PLAN_ROUND, "round.json"), JSON.stringify(edited));
        await inner.afterRoundSubmit(roundId, result);
      },
      sweep: () => inner.sweep(),
    };

    await submit([{ questionId: "ci", pick: APPROVE.ci }], editing);

    expect([await recordFiles(world.actionsDir), factory.posts]).toEqual([[], []]);
  });

  it("refuses a round whose binding names an option its question lacks, or no question at all", () => {
    const [ci, skill] = planBindings();
    const badOption = { ...planRound(), planApprovals: [{ ...ci, approve: "Approve everything" }, skill] };
    const noQuestion = { ...planRound(), planApprovals: [{ ...ci, questionId: "missing" }] };

    expect([RoundSchema.safeParse(planRound()).success, RoundSchema.safeParse(badOption).success, RoundSchema.safeParse(noQuestion).success]).toEqual([true, false, false]);
  });
});
