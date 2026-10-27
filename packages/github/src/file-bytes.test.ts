import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { fakeGitHub } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort, type GitHubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "octo/demo";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

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

describe("fileBytes over the fake", () => {
  it("returns a PNG's bytes exactly, including bytes that are not valid UTF-8", async () => {
    const fake = fakeGitHub();
    fake.bytes.set("main:snap.png", PNG);

    const bytes = await githubPort(fake.wire).fileBytes(REPO, "snap.png", "main");

    expect([...bytes!]).toEqual([...PNG]);
  });

  it("returns null for a path absent at the ref", async () => {
    const fake = fakeGitHub();
    fake.bytes.set("main:snap.png", PNG);

    expect(await githubPort(fake.wire).fileBytes(REPO, "snap.png", "topic")).toBeNull();
  });

  it("refuses a path that escapes the repo before any wire call", async () => {
    const fake = fakeGitHub();

    await expect(githubPort(fake.wire).fileBytes(REPO, "../snap.png", "main")).rejects.toBeInstanceOf(GitHubInputError);
    expect(fake.calls).toEqual([]);
  });
});

describe("fileBytes over the REST wire", () => {
  it("decodes a file the contents API inlined without a blob read", async () => {
    const { port, reads } = stubGh({ "repos/octo/demo/contents/snap.png": { type: "file", sha: "s1", size: PNG.length, encoding: "base64", content: b64(PNG) } });

    const bytes = await port.fileBytes(REPO, "snap.png", "main");

    expect([...bytes!]).toEqual([...PNG]);
    expect(reads).toEqual(["repos/octo/demo/contents/snap.png"]);
  });

  it("reads a 2 MB file the contents API does not inline through git/blobs", async () => {
    const large = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 7) % 256);
    const { port, reads } = stubGh(
      {
        "repos/octo/demo/contents/big.png": { type: "file", sha: "b2", size: large.length, encoding: "none", content: "" },
        "repos/octo/demo/git/blobs/b2": { sha: "b2", size: large.length, encoding: "base64", content: b64(large) },
      },
    );

    const bytes = await port.fileBytes(REPO, "big.png", "main");

    expect(Buffer.from(bytes!).equals(Buffer.from(large))).toBe(true);
    expect(reads).toEqual(["repos/octo/demo/contents/big.png", "repos/octo/demo/git/blobs/b2"]);
  });

  it("returns null when the contents API answers 404", async () => {
    const { port } = stubGh({});

    expect(await port.fileBytes(REPO, "gone.png", "main")).toBeNull();
  });

  it("throws when the decoded bytes are shorter than the size GitHub reported", async () => {
    const { port } = stubGh({ "repos/octo/demo/contents/snap.png": { type: "file", sha: "s1", size: PNG.length + 1, encoding: "base64", content: b64(PNG) } });

    await expect(port.fileBytes(REPO, "snap.png", "main")).rejects.toThrow(/decoded to 14 bytes, GitHub reported 15/);
  });

  it("throws for a directory rather than read it as a file", async () => {
    const { port } = stubGh({ "repos/octo/demo/contents/snaps": [{ type: "file", sha: "s1", size: 1 }] });

    await expect(port.fileBytes(REPO, "snaps", "main")).rejects.toThrow(/not a file/);
  });
});
