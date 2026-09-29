import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";
import { rateBudget } from "./budget.js";

const REPO = "octo/demo";
const MARKER = "<!-- shepherd:evidence -->";

interface Call {
  args: readonly string[];
  input?: string;
}

function included(headers: Record<string, string>, body: unknown): GhResult {
  const head = ["HTTP/2.0 200 OK", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join("\r\n");
  return { code: 0, stdout: `${head}\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
}

/** Answers by a path fragment, in order for repeats, and records every argv. */
function scripted(answers: Record<string, GhResult[]>): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const exec: GhExec = async (args, input) => {
    calls.push({ args, input });
    const line = args.join(" ");
    const key = Object.keys(answers).find((fragment) => line.includes(fragment));
    if (key === undefined) throw new Error(`unscripted gh call: ${line}`);
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);
    return answers[key]![Math.min(index, answers[key]!.length - 1)]!;
  };
  return { exec, calls };
}

const nextLink = (path: string) => ({ link: `<https://api.github.com/${path}>; rel="next"` });
const wireOver = (exec: GhExec) => githubPort(ghCliWire(exec, { budget: rateBudget() }));
const changed = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${offset + i}.ts`, status: "modified" }));

describe("listPrFiles", () => {
  it("returns both path and previousPath for a renamed file", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, [{ filename: "new/a.ts", previous_filename: "old/a.ts", status: "renamed" }, { filename: "b.ts", status: "added" }])] });

    const files = await wireOver(gh.exec).listPrFiles(REPO, 7);

    expect(files).toEqual([{ path: "new/a.ts", previousPath: "old/a.ts", status: "renamed" }, { path: "b.ts", status: "added" }]);
  });

  it("returns 130 entries when the files span two pages", async () => {
    const gh = scripted({
      "page=2": [included({}, changed(30, 100))],
      "pulls/7/files": [included(nextLink("repositories/1/pulls/7/files?per_page=100&page=2"), changed(100))],
    });

    const files = await wireOver(gh.exec).listPrFiles(REPO, 7);

    expect(files).toHaveLength(130);
    expect(files.at(-1)?.path).toBe("src/f129.ts");
  });

  it("sends each page conditional on its own ETag on a repeat read", async () => {
    const gh = scripted({ "pulls/7/files": [included({ etag: '"e1"' }, changed(2)), { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\netag: "e1"\r\n\r\n', stderr: "" }] });
    const port = wireOver(gh.exec);

    await port.listPrFiles(REPO, 7);
    const again = await port.listPrFiles(REPO, 7);

    expect(gh.calls[1]?.args).toContain('If-None-Match: "e1"');
    expect(again).toHaveLength(2);
  });

  it("uses only gh api REST calls, never graphql or pr view", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, [])], "compare/": [included({}, { merge_base_commit: { sha: fakeSha("mb") }, files: [] })], "issues/7/comments": [included({}, [])] });
    const port = wireOver(gh.exec);

    await port.listPrFiles(REPO, 7);
    await port.compareFiles(REPO, "main", "topic");
    await port.upsertComment(REPO, 7, MARKER, `${MARKER} hi`).catch(() => undefined);

    const lines = gh.calls.map((call) => call.args.join(" "));
    expect(lines.every((line) => line.startsWith("api -i") && !line.includes("graphql") && !line.includes("pr view"))).toBe(true);
  });
});

describe("compareFiles", () => {
  it("returns the merge base and the changed paths across pages", async () => {
    const mb = fakeSha("mb");
    const gh = scripted({
      "page=2": [included({}, { merge_base_commit: { sha: mb }, files: [{ filename: "c.ts" }] })],
      "compare/main...topic": [included(nextLink("repositories/1/compare/main...topic?per_page=100&page=2"), { merge_base_commit: { sha: mb }, files: [{ filename: "a.ts" }, { filename: "b.ts" }] })],
    });

    const result = await wireOver(gh.exec).compareFiles(REPO, "main", "topic");

    expect(result).toEqual({ mergeBaseSha: mb, files: ["a.ts", "b.ts", "c.ts"] });
  });

  it("returns no files when GitHub omits the list", async () => {
    const gh = scripted({ "compare/": [included({}, { merge_base_commit: { sha: fakeSha("mb") } })] });

    expect((await wireOver(gh.exec).compareFiles(REPO, "main", "topic")).files).toEqual([]);
  });
});

describe("upsertComment", () => {
  it("writes once for a repeated marker and skips as exists the second time", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const pr = fake.addPr({ headSha: fakeSha("h") });

    const first = await port.upsertComment("o/r", pr.number, MARKER, `${MARKER}\nevidence`);
    const second = await port.upsertComment("o/r", pr.number, MARKER, `${MARKER}\nevidence v2`);

    expect(first).toEqual({ id: expect.any(Number), done: true });
    expect(second).toEqual({ id: first.id, done: false, skipped: "exists" });
    expect(fake.calls.filter((call) => call === "createComment")).toHaveLength(1);
    expect(fake.calls.indexOf("listIssueComments")).toBeLessThan(fake.calls.indexOf("createComment"));
  });

  it("posts when other comments exist but none carries the marker", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const pr = fake.addPr({ headSha: fakeSha("h") });
    fake.comments.set(pr.number, [{ id: 1, body: "unrelated" }]);

    const result = await port.upsertComment("o/r", pr.number, MARKER, `${MARKER} x`);

    expect(result.done).toBe(true);
    expect(fake.comments.get(pr.number)).toHaveLength(2);
  });

  it("refuses an empty marker before any call", async () => {
    const fake = fakeGitHub();

    await expect(githubPort(fake.wire).upsertComment("o/r", 1, "", "x")).rejects.toThrow(/marker/);
    expect(fake.calls).toEqual([]);
  });

  it("lists then posts over the REST wire with the body as JSON input", async () => {
    const gh = scripted({ "issues/7/comments": [included({}, [{ id: 3, body: "other", user: {} }]), included({}, { id: 99 })] });

    const result = await wireOver(gh.exec).upsertComment(REPO, 7, MARKER, `${MARKER} ev`);

    expect(result).toEqual({ id: 99, done: true });
    expect(gh.calls[1]?.args).toEqual(["api", "-i", "-X", "POST", "repos/octo/demo/issues/7/comments", "--input", "-"]);
    expect(JSON.parse(gh.calls[1]!.input!)).toEqual({ body: `${MARKER} ev` });
  });
});

describe("fakeGitHub reads", () => {
  it("serves prFiles and compares, defaulting to no change", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    fake.prFiles.set(1, [{ path: "n.ts", previousPath: "o.ts", status: "renamed" }]);
    fake.compares.set("main...topic", { mergeBaseSha: fakeSha("mb"), files: ["x.ts"] });

    expect(await port.listPrFiles("o/r", 1)).toEqual([{ path: "n.ts", previousPath: "o.ts", status: "renamed" }]);
    expect(await port.compareFiles("o/r", "main", "topic")).toEqual({ mergeBaseSha: fakeSha("mb"), files: ["x.ts"] });
    expect((await port.compareFiles("o/r", "main", "other")).files).toEqual([]);
  });
});
