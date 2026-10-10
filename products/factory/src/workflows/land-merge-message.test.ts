import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPort } from "@titan-design/github";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, gateId, gateOpened, landScenario, type LandScenario } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { squashMessageFor, taskIdOf } from "./land-merge-message.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

// Built from parts so no address is a literal in the repo.
const personal = ["someone", "example.org"].join("@");
const noreply = ["12345+bot", "users.noreply.github.com"].join("@");
const trailers = `Co-authored-by: Pat <${noreply}>\nSigned-off-by: Pat <${personal}>`;

function dirtyPr(scenario: LandScenario): void {
  scenario.fake.squashSources.set(1, {
    title: "Add the widget",
    body: `Adds a widget.\n\n${trailers}`,
    commits: [
      { subject: "Wire the widget", body: `Reachable at ${personal} for questions.\n\n${trailers}` },
      { subject: "Fix the widget", body: trailers },
    ],
  });
}

async function mergeApproved(scenario: LandScenario): Promise<void> {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("land-test");
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  expect((await host.runtime.wait(runId)).status).toBe("completed");
}

describe("the squash message a land merge sends", () => {
  it("carries the formatted subject and body, with no trailers or addresses", async () => {
    const scenario = landScenario({ taskIds: ["TP-2132"] });
    dirtyPr(scenario);

    await mergeApproved(scenario);

    const [merge] = scenario.fake.merges;
    expect(merge?.message?.subject).toBe("Add the widget (TP-2132) (#1)");
    expect(merge?.message?.body).toContain("Wire the widget.");
    expect(merge?.message?.body).toContain("Refs: TP-2132, #1");
    const sent = `${merge?.message?.subject}\n${merge?.message?.body}`;
    for (const leaked of [personal, noreply, "Co-authored-by", "Signed-off-by"]) expect(sent).not.toContain(leaked);
  });

  it("falls back to the plain title and an empty body when formatting throws, and says so", async () => {
    const scenario = landScenario();
    const port = githubPort(scenario.fake.wire);
    const commits = [{ get subject(): string { throw new Error("boom"); }, body: "" }];
    const hostile = { ...port, getSquashSource: async () => ({ title: "Add the widget", body: "Adds a widget.", commits }) };
    const warn = vi.fn();

    const message = await squashMessageFor(hostile, "octo/demo", 1, [], warn);

    expect(message).toEqual({ subject: "Add the widget", body: "" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("taskIdOf", () => {
  it("names the id after the initiative", () => {
    expect(taskIdOf("titan-platform/TP-2132")).toEqual(["TP-2132"]);
    expect(taskIdOf(undefined)).toEqual([]);
  });
});
