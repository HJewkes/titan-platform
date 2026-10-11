import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha, successRun } from "./fake.js";
import { githubPort } from "./port.js";
import { formatPrStatus, prStatus } from "./pr-status.js";

function setup() {
  const fake = fakeGitHub();
  const head = fakeSha("head");
  return { fake, head, port: githubPort(fake.wire) };
}

describe("titan-gh pr-status", () => {
  it("reports an open PR with every required check green as ready", async () => {
    const { fake, head, port } = setup();
    const pr = fake.addPr({ headSha: head });
    fake.setRuns(head, [successRun("validate", 1), successRun("dag-check", 2)]);

    const status = await prStatus(port, "o/r", pr.number);

    expect(status).toMatchObject({ state: "open", ready: true, blockers: [] });
    expect(formatPrStatus(status)).toBe(`o/r#1 open ${head.slice(0, 7)} clean checks 2/2 ready`);
  });

  it("names a failing required check and blocks on it", async () => {
    const { fake, head, port } = setup();
    const pr = fake.addPr({ headSha: head });
    fake.setRuns(head, [successRun("validate", 1, undefined, "failure"), successRun("dag-check", 2)]);

    const line = formatPrStatus(await prStatus(port, "o/r", pr.number));

    expect(line).toBe(`o/r#1 open ${head.slice(0, 7)} clean checks 1/2 validate:failure blocked: check-failed`);
  });

  it("reports a required check that never ran at the head as missing", async () => {
    const { fake, head, port } = setup();
    const pr = fake.addPr({ headSha: head });
    fake.setRuns(head, [successRun("validate", 1)]);

    const line = formatPrStatus(await prStatus(port, "o/r", pr.number));

    expect(line).toContain("checks 1/2 dag-check:missing blocked: check-pending");
  });

  it("reports a draft PR as draft and blocked on it", async () => {
    const { fake, head, port } = setup();
    const pr = fake.addPr({ headSha: head, draft: true });
    fake.setRuns(head, [successRun("validate", 1), successRun("dag-check", 2)]);

    const line = formatPrStatus(await prStatus(port, "o/r", pr.number));

    expect(line).toBe(`o/r#1 draft ${head.slice(0, 7)} clean checks 2/2 blocked: draft`);
  });

  it("reports a merged PR as merged and never as unapproved", async () => {
    const { fake, head, port } = setup();
    const pr = fake.addPr({ headSha: head, state: "closed", merged: true });

    const status = await prStatus(port, "o/r", pr.number);

    expect(status.blockers.map((blocker) => blocker.reason)).toEqual(["merged"]);
    expect(formatPrStatus(status)).toBe(`o/r#1 merged ${head.slice(0, 7)} clean checks 0/2 validate:missing dag-check:missing blocked: merged`);
  });

  it("falls back to classic protection when the rulesets require nothing", async () => {
    const { fake, head, port } = setup();
    fake.rules = { contexts: [], strict: false };
    fake.classicRules = { contexts: ["build"], strict: false };
    const pr = fake.addPr({ headSha: head });
    fake.setRuns(head, [successRun("build", 1)]);

    const status = await prStatus(port, "o/r", pr.number);

    expect(status).toMatchObject({ ready: true, checks: [{ name: "build", state: "success" }] });
  });
});
