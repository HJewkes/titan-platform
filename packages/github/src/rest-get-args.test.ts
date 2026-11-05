import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { restCaller } from "./rest.js";

function recorder(): { exec: GhExec; argv: string[][] } {
  const argv: string[][] = [];
  const exec: GhExec = async (args) => {
    argv.push([...args]);
    return { code: 0, stdout: "HTTP/2.0 200 OK\n\n{}", stderr: "" };
  };
  return { exec, argv };
}

const noSleep = async (): Promise<void> => undefined;
const caller = (exec: GhExec) => restCaller(exec, rateBudget(), 10, noSleep);

describe("restCaller read argv", () => {
  it("sends a GET with fields as a query string, with no -X and no -f", async () => {
    const { exec, argv } = recorder();

    await caller(exec).get("repos/octo/demo/compare/a...b", { per_page: "1" });

    expect(argv).toEqual([["api", "-i", "repos/octo/demo/compare/a...b?per_page=1"]]);
  });

  it("sends a GET without fields as the bare path", async () => {
    const { exec, argv } = recorder();

    await caller(exec).get("repos/octo/demo/pulls/7");

    expect(argv).toEqual([["api", "-i", "repos/octo/demo/pulls/7"]]);
  });

  it("url-encodes special characters in keys and values", async () => {
    const { exec, argv } = recorder();

    await caller(exec).get("repos/octo/demo/issues", { "a b": "x&y=z/é+#", q: "is:open label:\"bug\"" });

    expect(argv[0]).toEqual(["api", "-i", "repos/octo/demo/issues?a%20b=x%26y%3Dz%2F%C3%A9%2B%23&q=is%3Aopen%20label%3A%22bug%22"]);
  });

  it("joins fields to a path that already has a query with an ampersand", async () => {
    const { exec, argv } = recorder();

    await caller(exec).get("repos/octo/demo/pulls?state=open", { per_page: "100" });

    expect(argv[0]).toEqual(["api", "-i", "repos/octo/demo/pulls?state=open&per_page=100"]);
  });

  it("keeps a key that appears both in the path and in the fields", async () => {
    const { exec, argv } = recorder();

    await caller(exec).get("repos/octo/demo/pulls?page=1", { page: "2" });

    expect(argv[0]).toEqual(["api", "-i", "repos/octo/demo/pulls?page=1&page=2"]);
  });

  it("sends text reads with the escape-sequence flag after the path", async () => {
    const { exec, argv } = recorder();

    await caller(exec).text("repos/octo/demo/actions/jobs/42/logs");

    expect(argv[0]).toEqual(["api", "-i", "repos/octo/demo/actions/jobs/42/logs", "--allow-escape-sequences"]);
  });

  it("leaves non-GET calls on -X with -f fields", async () => {
    const { exec, argv } = recorder();

    await caller(exec).send("POST", "repos/octo/demo/issues/1/comments", { body: "hi there" });

    expect(argv).toEqual([["api", "-i", "-X", "POST", "repos/octo/demo/issues/1/comments", "-f", "body=hi there"]]);
  });
});
