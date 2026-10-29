import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { fakeGitHub } from "./fake.js";
import { BlobTooLargeError } from "./file-bytes.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort, type GitHubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "octo/demo";
const MiB = 1024 * 1024;
const CONTENTS = "repos/octo/demo/contents/big.png";
const BLOB = "repos/octo/demo/git/blobs/b1";

/** A `gh api` that answers by exact path, 404 for any other, and records each path read without its query. */
function stubGh(answers: Record<string, unknown>): { port: GitHubPort; reads: string[] } {
  const reads: string[] = [];
  const exec: GhExec = async (args) => {
    const path = args[2]?.split("?")[0] ?? "";
    reads.push(path);
    if (!(path in answers)) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(answers[path])}`, stderr: "" };
  };
  return { port: githubPort(ghCliWire(exec, { budget: rateBudget() })), reads };
}

/** A blob GitHub reports at `size` and does not inline; its git/blobs answer is tiny, as only the read itself is under test. */
const notInlined = (size: unknown) => ({
  [CONTENTS]: { type: "file", sha: "b1", size, encoding: "none", content: "" },
  [BLOB]: { sha: "b1", size: 3, encoding: "base64", content: Buffer.from([1, 2, 3]).toString("base64") },
});

describe("fileBytes with maxBytes over the REST wire", () => {
  it("refuses a 50 MiB file under a 5 MiB cap from the contents entry, with no git/blobs read", async () => {
    const { port, reads } = stubGh(notInlined(50 * MiB));

    const read = port.fileBytes(REPO, "big.png", "main", { maxBytes: 5 * MiB });

    await expect(read).rejects.toEqual(new BlobTooLargeError(50 * MiB, 5 * MiB));
    expect(reads).toEqual([CONTENTS]);
  });

  it("refuses a contents entry with no numeric size rather than download an unknown amount", async () => {
    const { port, reads } = stubGh(notInlined("huge"));

    await expect(port.fileBytes(REPO, "big.png", "main", { maxBytes: 5 * MiB })).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(reads).toEqual([CONTENTS]);
  });

  it("reads a file whose size is exactly the cap", async () => {
    const { port, reads } = stubGh(notInlined(3));

    const bytes = await port.fileBytes(REPO, "big.png", "main", { maxBytes: 3 });

    expect([...bytes!]).toEqual([1, 2, 3]);
    expect(reads).toEqual([CONTENTS, BLOB]);
  });
});

describe("fileBytes with maxBytes over the fake", () => {
  it("refuses stored bytes over the cap as the REST wire does", async () => {
    const fake = fakeGitHub();
    fake.bytes.set("main:snap.png", new Uint8Array(11));

    await expect(githubPort(fake.wire).fileBytes(REPO, "snap.png", "main", { maxBytes: 10 })).rejects.toEqual(new BlobTooLargeError(11, 10));
  });

  it("refuses a cap that is not a positive integer before any wire call", async () => {
    const fake = fakeGitHub();

    await expect(githubPort(fake.wire).fileBytes(REPO, "snap.png", "main", { maxBytes: 0 })).rejects.toBeInstanceOf(GitHubInputError);
    expect(fake.calls).toEqual([]);
  });
});
