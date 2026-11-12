import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { fakeGitHub } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort, type GitHubPort } from "./port.js";

const REPO = "octo/demo";
const DIR = "repos/octo/demo/contents/rows";

/** A `gh api` that answers by exact path and 404s any other. */
function stubGh(answers: Record<string, unknown>): GitHubPort {
  const exec: GhExec = async (args) => {
    const path = args[2]?.split("?")[0] ?? "";
    if (!(path in answers)) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(answers[path])}`, stderr: "" };
  };
  return githubPort(ghCliWire(exec, { budget: rateBudget() }));
}

const entry = (name: string, type = "file") => ({ type, path: `rows/${name}`, sha: `sha-${name}` });

describe("listFiles over the REST wire", () => {
  it("answers the directory's files with their blob shas and leaves subdirectories out", async () => {
    const port = stubGh({ [DIR]: [entry("1.json"), entry("nested", "dir"), entry("2.json")] });

    const listed = await port.listFiles(REPO, "rows", "main");

    expect(listed).toEqual([
      { path: "rows/1.json", blobSha: "sha-1.json" },
      { path: "rows/2.json", blobSha: "sha-2.json" },
    ]);
  });

  it("answers null for a path with nothing at it", async () => {
    await expect(stubGh({}).listFiles(REPO, "rows", "main")).resolves.toBeNull();
  });

  it("throws for a path that is a file, never answering it as an empty directory", async () => {
    const port = stubGh({ [DIR]: entry("rows") });

    await expect(port.listFiles(REPO, "rows", "main")).rejects.toThrow("rows at main is not a directory");
  });

  it("throws for a listing at GitHub's 1,000-entry cap, which may be short", async () => {
    const port = stubGh({ [DIR]: Array.from({ length: 1000 }, (_, i) => entry(`${i}.json`)) });

    await expect(port.listFiles(REPO, "rows", "main")).rejects.toThrow("at GitHub's cap of 1000");
  });
});

describe("listFiles on the fake", () => {
  it("lists the files set directly under the directory at that ref only", async () => {
    const fake = fakeGitHub();
    fake.files.set("main:rows/2.json", { content: "[]", blobSha: "b2" });
    fake.files.set("main:rows/1.json", { content: "[]", blobSha: "b1" });
    fake.files.set("main:rows/deeper/3.json", { content: "[]", blobSha: "b3" });
    fake.files.set("other:rows/4.json", { content: "[]", blobSha: "b4" });

    const listed = await githubPort(fake.wire).listFiles(REPO, "rows", "main");

    expect(listed).toEqual([
      { path: "rows/1.json", blobSha: "b1" },
      { path: "rows/2.json", blobSha: "b2" },
    ]);
    await expect(githubPort(fake.wire).listFiles(REPO, "absent", "main")).resolves.toBeNull();
  });
});
