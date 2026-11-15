import { describe, expect, it } from "vitest";
import { byId, emptyWorld, fixtureFactory, HEAD, REPO, RUN_G10, RUN_GONE, RUN_OWNER, RUN_PLAIN, useInboxViewWorld } from "./inbox-view.test-helpers.js";

const { writeShipRound, writeImpostorDeposit, listInbox, serveFactory } = useInboxViewWorld(emptyWorld());

describe("inbox.list on a fixture factory, every source kind", () => {
  it("returns every source kind with its action, blocking first and newest first", async () => {
    await writeShipRound("ship-r1", new Date("2026-10-10T01:00:00.000Z"));
    const depositId = await writeImpostorDeposit();

    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(list.gaps).toEqual([]);
    expect(list.items.map((each) => [each.id, each.section, each.action.kind])).toEqual([
      [depositId, "blocking", "answer-deposit"],
      [`gate:${RUN_OWNER}/approve-merge`, "blocking", "owner-release"],
      [`gate:${RUN_G10}/approve-merge`, "blocking", "hold-release"],
      [`gate:${RUN_PLAIN}/approve-merge`, "blocking", "resolve-gate"],
      ["chat:msg-7", "blocking", "answer-chat"],
      ["round:ship-r1/ship", "blocking", "open-round"],
      ["task:EX-9", "planning", "open"],
      ["morning:m-1", "planning", "open"],
      [`gate:${RUN_GONE}/approve-merge`, "planning", "terminal"],
    ]);
    expect(byId(list, `gate:${RUN_G10}/approve-merge`)).toMatchObject({ hold: { class: "g10-review" }, action: { holdClass: "g10-review", pr: 3, headSha: HEAD }, then: { kind: "resolve-gate" } });
    expect(byId(list, `gate:${RUN_PLAIN}/approve-merge`)?.action).toEqual({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, runId: RUN_PLAIN, stepId: "approve-merge", repo: REPO, pr: 1, headSha: HEAD, decision: "merge" });
    expect(byId(list, `gate:${RUN_GONE}/approve-merge`)?.action).toMatchObject({ command: `titan-factory gate resolve ${RUN_GONE} approve-merge --json '<payload>'` });
    expect(byId(list, "task:EX-9")).toMatchObject({ evidence: "#/tasks/EX-9", action: { route: "#/tasks/EX-9" } });
    expect(byId(list, "round:ship-r1/ship")).toMatchObject({ evidence: "#/rounds/ship-r1", action: { roundId: "ship-r1" } });
  });
});
