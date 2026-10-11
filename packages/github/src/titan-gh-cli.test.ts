import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha, successRun } from "./fake.js";
import { githubPort } from "./port.js";
import { runTitanGhCli } from "./titan-gh-cli.js";

async function run(args: string[]) {
  const fake = fakeGitHub();
  const head = fakeSha("head");
  fake.addPr({ headSha: head });
  fake.setRuns(head, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.squashSources.set(1, { title: "Add the widget", body: "Adds the widget.", commits: [] });
  let out = "";
  let err = "";
  const code = await runTitanGhCli(args, { out: (text) => (out += text), err: (line) => (err += `${line}\n`) }, githubPort(fake.wire));
  return { code, out, err, fake };
}

describe("titan-gh", () => {
  it("prints pr-status as one JSON object with --json", async () => {
    const result = await run(["pr-status", "o/r#1", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ repo: "o/r", number: 1, state: "open", ready: true, checks: [{ name: "validate", state: "success" }, { name: "dag-check", state: "success" }] });
  });

  it("dispatches pr-context", async () => {
    const result = await run(["pr-context", "o/r#1"]);

    expect(result.code).toBe(0);
    expect(result.out.split("\n")[0]).toBe("o/r#1 Add the widget");
  });

  it("exits 2 with usage and an example for an unknown verb", async () => {
    const result = await run(["pr-merge", "o/r#1"]);

    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("usage: titan-gh <verb> <owner/repo#N> [--json]");
    expect(result.err).toContain("example: titan-gh pr-status");
  });

  it.each(["o/r", "o/r#0", "o/r#x", "o#1", "o/r/x#1", "https://github.com/o/r/pull/1"])("exits 2 before any GitHub read for the malformed ref %s", async (ref) => {
    const result = await run(["pr-status", ref]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("usage: titan-gh");
    expect(result.fake.calls).toEqual([]);
  });
});
