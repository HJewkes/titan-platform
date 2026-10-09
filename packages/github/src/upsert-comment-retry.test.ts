import { describe, expect, it } from "vitest";
import { FakeHttpError, fakeGitHub, fakeSha } from "./fake.js";
import { githubPort } from "./port.js";

const MARKER = "<!-- shepherd-evidence:abc -->";

function setup() {
  const fake = fakeGitHub();
  const waits: number[] = [];
  const port = githubPort(fake.wire, { sleep: async (ms) => void waits.push(ms) });
  const pr = fake.addPr({ headSha: fakeSha("h") });
  return { fake, port, pr, waits };
}

describe("upsertComment retry", () => {
  it("posts once after a 502 that did not land", async () => {
    const { fake, port, pr, waits } = setup();
    fake.createCommentFaults = [{ error: new FakeHttpError(502, "bad gateway") }];

    const result = await port.upsertComment("o/r", pr.number, MARKER, `${MARKER}\nev`);

    expect(result.done).toBe(true);
    expect(waits).toEqual([1000]);
    expect(fake.comments.get(pr.number)).toHaveLength(1);
  });

  it("treats a post that landed before the answer was lost as done, without posting again", async () => {
    const { fake, port, pr } = setup();
    fake.createCommentFaults = [{ error: new SyntaxError("unexpected end of JSON input"), lands: true }];

    const result = await port.upsertComment("o/r", pr.number, MARKER, `${MARKER}\nev`);

    expect(result).toEqual({ id: expect.any(Number), done: true });
    expect(fake.calls.filter((call) => call === "createComment")).toHaveLength(1);
    expect(fake.comments.get(pr.number)).toHaveLength(1);
  });

  it("fails with the last error after bounded attempts on a persistent 502", async () => {
    const { fake, port, pr, waits } = setup();
    fake.createCommentFaults = Array.from({ length: 10 }, () => ({ error: new FakeHttpError(502, "bad gateway") }));

    await expect(port.upsertComment("o/r", pr.number, MARKER, MARKER)).rejects.toThrow(/502/);

    expect(waits).toEqual([1000, 3000, 5000]);
    expect(fake.calls.filter((call) => call === "createComment")).toHaveLength(4);
  });

  it("does not retry a 4xx", async () => {
    const { fake, port, pr, waits } = setup();
    fake.createCommentFaults = [{ error: new FakeHttpError(403, "forbidden") }];

    await expect(port.upsertComment("o/r", pr.number, MARKER, MARKER)).rejects.toThrow(/403/);

    expect(waits).toEqual([]);
  });
});
