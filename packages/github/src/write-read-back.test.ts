import { describe, expect, it } from "vitest";
import { FakeHttpError, fakeGitHub, fakeSha } from "./fake.js";
import { githubPort } from "./port.js";

const HEAD = fakeSha("h");
const RUN = 77;

function setup() {
  const fake = fakeGitHub();
  const waits: number[] = [];
  const port = githubPort(fake.wire, { sleep: async (ms) => void waits.push(ms) });
  const pr = fake.addPr({ headSha: HEAD });
  return { fake, port, pr, waits };
}

const badGateway = () => ({ error: new FakeHttpError(502, "bad gateway") });
const calls = (fake: { calls: string[] }, name: string) => fake.calls.filter((call) => call === name).length;

describe("merge retry", () => {
  it("merges once after a 502 that did not land", async () => {
    const { fake, port, pr, waits } = setup();
    fake.mergeFaults = [badGateway()];

    const result = await port.merge("o/r", pr.number, HEAD, "squash");

    expect(result).toEqual({ mergeSha: fake.pr(pr.number).mergeSha, done: true });
    expect(fake.effects.merge).toBe(1);
    expect(calls(fake, "merge")).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("treats a merge that landed before the answer was lost as done, without a second PUT", async () => {
    const { fake, port, pr } = setup();
    fake.mergeFaults = [{ error: new SyntaxError("unexpected end of JSON input"), lands: true }];

    const result = await port.merge("o/r", pr.number, HEAD, "squash");

    expect(result).toEqual({ mergeSha: fake.pr(pr.number).mergeSha, done: true });
    expect(calls(fake, "merge")).toBe(1);
    expect(fake.effects.merge).toBe(1);
  });

  it("does not count a merge at a different head as its own", async () => {
    const { fake, port, pr } = setup();
    fake.mergeFaults = [badGateway()];
    fake.onGetPr = (live, reads) => {
      if (reads === 2) Object.assign(live, { merged: true, state: "closed", headSha: fakeSha("other"), mergeSha: fakeSha("m") });
    };

    await expect(port.merge("o/r", pr.number, HEAD, "squash")).rejects.toThrow(/405/);
    expect(fake.effects.merge).toBe(0);
  });

  it("fails with the step named after the bound on a persistent 502", async () => {
    const { fake, port, pr, waits } = setup();
    fake.mergeFaults = Array.from({ length: 10 }, badGateway);

    await expect(port.merge("o/r", pr.number, HEAD, "squash")).rejects.toThrow(new RegExp(`merge PUT o/r#${pr.number} at ${HEAD}.*502`));
    expect(calls(fake, "merge")).toBe(2);
    expect(waits).toEqual([1000, 3000]);
  });

  it.each([409, 422])("does not retry a %i", async (status) => {
    const { fake, port, pr, waits } = setup();
    fake.mergeFaults = [{ error: new FakeHttpError(status, "refused") }];

    await expect(port.merge("o/r", pr.number, HEAD, "squash")).rejects.toThrow(new RegExp(String(status)));
    expect(calls(fake, "merge")).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe("rerunFailed retry", () => {
  it("re-requests once after a 502 that did not land", async () => {
    const { fake, port, waits } = setup();
    fake.rerunFaults = [badGateway()];

    expect(await port.rerunFailed("o/r", RUN)).toEqual({ done: true });
    expect(fake.effects.rerunFailedJobs).toBe(1);
    expect(calls(fake, "rerunFailedJobs")).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("treats a rerun queued before the answer was lost as done, without re-requesting", async () => {
    const { fake, port } = setup();
    fake.rerunFaults = [{ error: new FakeHttpError(502, "bad gateway"), lands: true }];

    expect(await port.rerunFailed("o/r", RUN)).toEqual({ done: true });
    expect(calls(fake, "rerunFailedJobs")).toBe(1);
  });

  it("fails with the step named after the bound on a persistent 502", async () => {
    const { fake, port, waits } = setup();
    fake.rerunFaults = Array.from({ length: 10 }, badGateway);

    await expect(port.rerunFailed("o/r", RUN)).rejects.toThrow(new RegExp(`rerun-failed-jobs o/r run ${RUN}.*502`));
    expect(calls(fake, "rerunFailedJobs")).toBe(2);
    expect(waits).toEqual([1000, 3000]);
  });

  it.each([403, 422])("does not retry a %i", async (status) => {
    const { fake, port, waits } = setup();
    fake.rerunFaults = [{ error: new FakeHttpError(status, "refused") }];

    await expect(port.rerunFailed("o/r", RUN)).rejects.toThrow(new RegExp(String(status)));
    expect(calls(fake, "rerunFailedJobs")).toBe(1);
    expect(waits).toEqual([]);
  });
});
