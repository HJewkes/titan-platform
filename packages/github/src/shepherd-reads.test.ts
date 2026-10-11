import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { COMPARE_FILE_CAP, FileListTruncatedError, PR_COMMITS_CAP, PR_FILES_CAP, githubPort } from "./port.js";
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
    const gh = scripted({ "pulls/7/files": [included({}, [{ filename: "new/a.ts", previous_filename: "old/a.ts", status: "renamed" }, { filename: "b.ts", status: "added" }])], "repos/octo/demo/pulls/7": [included({}, { changed_files: 2 })] });

    const files = await wireOver(gh.exec).listPrFiles(REPO, 7);

    expect(files).toEqual([{ path: "new/a.ts", previousPath: "old/a.ts", status: "renamed" }, { path: "b.ts", status: "added" }]);
  });

  it("carries each file's additions and deletions from the same list", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, [{ filename: "a.ts", status: "modified", additions: 12, deletions: 3 }])], "repos/octo/demo/pulls/7": [included({}, { changed_files: 1 })] });

    const files = await wireOver(gh.exec).listPrFiles(REPO, 7);

    expect(files).toEqual([{ path: "a.ts", status: "modified", additions: 12, deletions: 3 }]);
  });

  it("returns 130 entries when the files span two pages", async () => {
    const gh = scripted({
      "page=2": [included({}, changed(30, 100))],
      "pulls/7/files": [included(nextLink("repositories/1/pulls/7/files?per_page=100&page=2"), changed(100))],
      "repos/octo/demo/pulls/7": [included({}, { changed_files: 130 })],
    });

    const files = await wireOver(gh.exec).listPrFiles(REPO, 7);

    expect(files).toHaveLength(130);
    expect(files.at(-1)?.path).toBe("src/f129.ts");
  });

  it("sends each page conditional on its own ETag on a repeat read", async () => {
    const gh = scripted({ "pulls/7/files": [included({ etag: '"e1"' }, changed(2)), { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\netag: "e1"\r\n\r\n', stderr: "" }], "repos/octo/demo/pulls/7": [included({}, { changed_files: 2 })] });
    const port = wireOver(gh.exec);

    await port.listPrFiles(REPO, 7);
    const again = await port.listPrFiles(REPO, 7);

    expect(gh.calls.some((call) => call.args.includes('If-None-Match: "e1"'))).toBe(true);
    expect(again).toHaveLength(2);
  });

  it("uses only gh api REST calls, never graphql or pr view", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, [])], "repos/octo/demo/pulls/7": [included({}, { changed_files: 0 })], "compare/": [included({}, { merge_base_commit: { sha: fakeSha("mb") }, files: [] })], "issues/7/comments": [included({}, [])], "-X GET user": [included({}, { login: "octo" })] });
    const port = wireOver(gh.exec);

    await port.listPrFiles(REPO, 7);
    await port.compareFiles(REPO, "main", "topic");
    await port.upsertComment(REPO, 7, MARKER, `${MARKER} hi`).catch(() => undefined);

    const lines = gh.calls.map((call) => call.args.join(" "));
    expect(lines.every((line) => line.startsWith("api -i") && !line.includes("graphql") && !line.includes("pr view"))).toBe(true);
  });
});

describe("listPrCommits", () => {
  const shas = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => fakeSha(`c${offset + i}`));

  it("returns the PR's commit shas oldest first across pages", async () => {
    const gh = scripted({
      "page=2": [included({}, shas(20, 100).map((sha) => ({ sha })))],
      "pulls/7/commits": [included(nextLink("repositories/1/pulls/7/commits?per_page=100&page=2"), shas(100).map((sha) => ({ sha })))],
    });

    const commits = await wireOver(gh.exec).listPrCommits(REPO, 7);

    expect(commits).toEqual([...shas(100), ...shas(20, 100)]);
  });

  it("answers the head alone for an unset PR and stops at 250 like GitHub", async () => {
    const fake = fakeGitHub();
    const head = fakeSha("head");
    fake.addPr({ headSha: head });
    fake.addPr({ headSha: fakeSha("other") });
    fake.prCommits.set(2, shas(300));

    expect(await githubPort(fake.wire).listPrCommits("o/r", 1)).toEqual([head]);
    expect(await githubPort(fake.wire).listPrCommits("o/r", 2)).toEqual(shas(PR_COMMITS_CAP));
  });
});

describe("listDefaultBranchCommits", () => {
  const logged = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => ({ sha: fakeSha(`m${offset + i}`), commit: { message: `subject ${offset + i}\n\nbody` } }));

  it("reads every page of the default branch since the given time, as UTC", async () => {
    const gh = scripted({ "page=2": [included({}, logged(5, 100))], "repos/octo/demo/commits": [included(nextLink("repositories/1/commits?per_page=100&page=2"), logged(100))] });

    const commits = await wireOver(gh.exec).listDefaultBranchCommits(REPO, "2026-10-01T02:00:00+02:00");

    expect(commits).toHaveLength(105);
    expect(commits[0]).toEqual({ sha: fakeSha("m0"), message: "subject 0\n\nbody" });
    expect(gh.calls[0]!.args).toContain("since=2026-10-01T00:00:00.000Z");
  });

  it("refuses a since that is not a timestamp before any call", async () => {
    const gh = scripted({});

    await expect(wireOver(gh.exec).listDefaultBranchCommits(REPO, "last week")).rejects.toThrow(/invalid since/);
    expect(gh.calls).toHaveLength(0);
  });

  it("answers only the fake history at or after since, newest first", async () => {
    const fake = fakeGitHub();
    fake.history.push({ sha: fakeSha("old"), message: "old", committedAt: "2026-09-30T00:00:00Z" }, { sha: fakeSha("a"), message: "a", committedAt: "2026-10-01T00:00:00Z" }, { sha: fakeSha("b"), message: "b", committedAt: "2026-10-02T00:00:00Z" });

    const commits = await githubPort(fake.wire).listDefaultBranchCommits("o/r", "2026-10-01T00:00:00Z");

    expect(commits.map((commit) => commit.message)).toEqual(["b", "a"]);
  });
});

describe("listPrFiles caps", () => {
  const files = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `f${i}.ts`, status: "modified" }));

  it("throws FileListTruncatedError for a PR of 3,005 files when GitHub lists 3,000", async () => {
    const fake = fakeGitHub();
    fake.prFiles.set(1, files(3005));
    fake.prChangedFiles.set(1, 3005);

    const read = githubPort(fake.wire).listPrFiles("o/r", 1);

    await expect(read).rejects.toBeInstanceOf(FileListTruncatedError);
    await expect(read).rejects.toMatchObject({ expected: 3005, received: PR_FILES_CAP });
  });

  it("returns all 3,000 files of a 3,000-file PR", async () => {
    const fake = fakeGitHub();
    fake.prFiles.set(1, files(3000));

    expect(await githubPort(fake.wire).listPrFiles("o/r", 1)).toHaveLength(3000);
  });

  it("throws over the REST wire when the PR reports more files than the pages held", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, changed(100))], "repos/octo/demo/pulls/7": [included({}, { changed_files: 3005 })] });

    await expect(wireOver(gh.exec).listPrFiles(REPO, 7)).rejects.toBeInstanceOf(FileListTruncatedError);
  });

  it("throws over the REST wire when the PR reports no changed_files count", async () => {
    const gh = scripted({ "pulls/7/files": [included({}, changed(1))], "repos/octo/demo/pulls/7": [included({}, {})] });

    await expect(wireOver(gh.exec).listPrFiles(REPO, 7)).rejects.toThrow(/changed_files/);
  });
});

describe("compareFiles caps", () => {
  const paths = (count: number) => Array.from({ length: count }, (_, i) => `f${i}.ts`);
  const mergeBaseSha = fakeSha("mb");

  it("marks a compare that hit 300 files as truncated", async () => {
    const fake = fakeGitHub();
    fake.compares.set("main...topic", { mergeBaseSha, files: paths(COMPARE_FILE_CAP) });

    const result = await githubPort(fake.wire).compareFiles("o/r", "main", "topic");

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(COMPARE_FILE_CAP);
  });

  it("does not mark 299 files as truncated", async () => {
    const fake = fakeGitHub();
    fake.compares.set("main...topic", { mergeBaseSha, files: paths(299) });

    expect((await githubPort(fake.wire).compareFiles("o/r", "main", "topic")).truncated).toBe(false);
  });

  it("marks more than 250 commits as truncated", async () => {
    const fake = fakeGitHub();
    fake.compares.set("main...topic", { mergeBaseSha, files: paths(3), totalCommits: 251 });

    expect((await githubPort(fake.wire).compareFiles("o/r", "main", "topic")).truncated).toBe(true);
  });

  it("marks a REST compare of 300 files over three pages as truncated", async () => {
    const page = (offset: number, headers: Record<string, string>) => included(headers, { merge_base_commit: { sha: mergeBaseSha }, total_commits: 3, commits: [{}, {}, {}], files: paths(100).map((filename) => ({ filename: `${offset}${filename}` })) });
    const gh = scripted({
      "page=3": [page(3, {})],
      "page=2": [page(2, nextLink("repositories/1/compare/main...topic?per_page=100&page=3"))],
      "compare/main...topic": [page(1, nextLink("repositories/1/compare/main...topic?per_page=100&page=2"))],
    });

    expect((await wireOver(gh.exec).compareFiles(REPO, "main", "topic")).truncated).toBe(true);
  });

  it("marks a REST compare whose total_commits exceeds the commits returned as truncated", async () => {
    const gh = scripted({ "compare/": [included({}, { merge_base_commit: { sha: mergeBaseSha }, total_commits: 400, commits: paths(250), files: [{ filename: "a.ts" }] })] });

    expect((await wireOver(gh.exec).compareFiles(REPO, "main", "topic")).truncated).toBe(true);
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

    expect(result).toEqual({ mergeBaseSha: mb, files: ["a.ts", "b.ts", "c.ts"], truncated: false });
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
    fake.comments.set(pr.number, [{ id: 1, body: "unrelated", author: fake.actor }]);

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
    const gh = scripted({ "-X GET user": [included({}, { login: "octo" })], "issues/7/comments": [included({}, [{ id: 3, body: "other", user: { login: "octo" } }]), included({}, { id: 99 })] });

    const result = await wireOver(gh.exec).upsertComment(REPO, 7, MARKER, `${MARKER}\nev`);

    const post = gh.calls.find((call) => call.args.includes("POST"));
    expect(result).toEqual({ id: 99, done: true });
    expect(post?.args).toEqual(["api", "-i", "-X", "POST", "repos/octo/demo/issues/7/comments", "--input", "-"]);
    expect(JSON.parse(post!.input!)).toEqual({ body: `${MARKER}\nev` });
  });

  it("counts only the authenticated user's comment as the existing one, over the REST wire", async () => {
    const forged = { id: 1, body: MARKER, user: { login: "mallory" } };
    const own = { id: 2, body: `${MARKER}\nevidence`, user: { login: "octo" } };
    const gh = scripted({ "-X GET user": [included({}, { login: "octo" })], "issues/7/comments": [included({}, [forged, own])] });

    expect(await wireOver(gh.exec).upsertComment(REPO, 7, MARKER, MARKER)).toEqual({ id: 2, done: false, skipped: "exists" });
  });

  it("does not count another author's comment holding the marker", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("h") });
    fake.comments.set(pr.number, [{ id: 1, body: MARKER, author: "mallory" }]);

    const result = await githubPort(fake.wire).upsertComment("o/r", pr.number, MARKER, MARKER);

    expect(result.done).toBe(true);
    expect(fake.comments.get(pr.number)).toHaveLength(2);
  });

  it("does not count a longer marker that contains ours, or ours inside a line of other text", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("h") });
    fake.comments.set(pr.number, [
      { id: 1, body: "<!-- shepherd:evidence -->-v2", author: fake.actor },
      { id: 2, body: `quoting ${MARKER} inline`, author: fake.actor },
    ]);

    const result = await githubPort(fake.wire).upsertComment("o/r", pr.number, MARKER, MARKER);

    expect(result.done).toBe(true);
  });

  it("finds the marker on its own line in a multi-line body, with CRLF endings", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("h") });
    fake.comments.set(pr.number, [{ id: 4, body: `intro\r\n${MARKER}\r\nevidence`, author: fake.actor }]);

    expect(await githubPort(fake.wire).upsertComment("o/r", pr.number, MARKER, MARKER)).toEqual({ id: 4, done: false, skipped: "exists" });
  });

  it("finds a marker line with trailing whitespace", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("h") });
    fake.comments.set(pr.number, [{ id: 4, body: `${MARKER} \t\nevidence`, author: fake.actor }]);

    expect(await githubPort(fake.wire).upsertComment("o/r", pr.number, MARKER, MARKER)).toEqual({ id: 4, done: false, skipped: "exists" });
  });

  it("owns comments as the configured bot login without calling GET /user, which an App token gets 403 on", async () => {
    const own = { id: 2, body: `${MARKER}\nev`, user: { login: "shepherd[bot]" } };
    const gh = scripted({ "issues/7/comments": [included({}, [{ id: 1, body: MARKER, user: { login: "mallory" } }, own]), included({}, { id: 99 })] });
    const port = githubPort(ghCliWire(gh.exec, { budget: rateBudget() }), { login: "shepherd[bot]" });

    expect(await port.upsertComment(REPO, 7, MARKER, MARKER)).toEqual({ id: 2, done: false, skipped: "exists" });
    expect(gh.calls.some((call) => call.args.includes("user"))).toBe(false);
  });

  it("posts under the configured login when none of its comments carries the marker", async () => {
    const gh = scripted({ "issues/7/comments": [included({}, [{ id: 1, body: MARKER, user: { login: "octo" } }]), included({}, { id: 99 })] });
    const port = githubPort(ghCliWire(gh.exec, { budget: rateBudget() }), { login: "shepherd[bot]" });

    expect(await port.upsertComment(REPO, 7, MARKER, MARKER)).toEqual({ id: 99, done: true });
  });

  it("resolves the authenticated user once across calls", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const pr = fake.addPr({ headSha: fakeSha("h") });

    await port.upsertComment("o/r", pr.number, MARKER, MARKER);
    await port.upsertComment("o/r", pr.number, MARKER, MARKER);

    expect(fake.calls.filter((call) => call === "getAuthenticatedLogin")).toHaveLength(1);
  });
});

describe("fakeGitHub reads", () => {
  it("serves prFiles and compares, defaulting to no change", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    fake.prFiles.set(1, [{ path: "n.ts", previousPath: "o.ts", status: "renamed" }]);
    fake.compares.set("main...topic", { mergeBaseSha: fakeSha("mb"), files: ["x.ts"] });

    expect(await port.listPrFiles("o/r", 1)).toEqual([{ path: "n.ts", previousPath: "o.ts", status: "renamed" }]);
    expect(await port.compareFiles("o/r", "main", "topic")).toEqual({ mergeBaseSha: fakeSha("mb"), files: ["x.ts"], truncated: false });
    expect((await port.compareFiles("o/r", "main", "other")).files).toEqual([]);
  });
});
