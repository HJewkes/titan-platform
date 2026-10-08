import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";

const REPO = "octo/demo";
const H1 = fakeSha("head1");

const pull = (sha: string) => ({ number: 7, state: "open", merged: false, merge_commit_sha: null, draft: false, mergeable_state: "clean", head: { ref: "topic", sha, repo: { full_name: REPO } }, base: { ref: "main" } });

function answer(status: number, body: unknown, stderr = "", etag?: string): GhResult {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const head = etag === undefined ? "" : `\r\nETag: ${etag}`;
  return { code: status < 300 ? 0 : 1, stdout: `HTTP/2.0 ${status} X${head}\r\n\r\n${text}`, stderr: status < 300 ? "" : stderr || `gh: HTTP ${status}\n` };
}

/** Each route answers its queued results in order, repeating the last one; every call is recorded. */
function wireOf(routes: Record<string, GhResult[]>) {
  const calls: string[] = [];
  const slept: number[] = [];
  const exec: GhExec = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(routes).find((fragment) => line.includes(fragment))!;
    const queue = routes[key]!;
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
  const wire = ghCliWire(exec, { sleep: async (ms) => void slept.push(ms) });
  return { wire, port: githubPort(wire), calls, slept };
}
const compare = answer(200, { behind_by: 2 });

describe("gh read retry", () => {
  it("merge continues after the PR read answers HTTP 500 once", async () => {
    const gh = wireOf({ "pulls/7/merge": [answer(200, { sha: "m1" })], "compare/": [compare], "pulls/7": [answer(500, "", "gh: HTTP 500"), answer(200, pull(H1))] });

    const result = await gh.port.merge(REPO, 7, H1, "squash");

    expect(result).toEqual({ mergeSha: "m1", done: true });
    expect(gh.slept).toHaveLength(1);
  });

  it("update-branch continues after the PR read answers HTTP 502 once", async () => {
    const gh = wireOf({ "pulls/7/update-branch": [answer(202, { message: "Updating" })], "compare/": [compare], "pulls/7": [answer(502, ""), answer(200, pull(H1))] });

    expect(await gh.port.updateBranch(REPO, 7, H1)).toEqual({ done: true });
  });

  it("retries a connection error", async () => {
    const down: GhResult = { code: 1, stdout: "", stderr: "error connecting to api.github.com\n" };
    const gh = wireOf({ "repos/octo/demo": [down, answer(200, { default_branch: "main" })] });

    expect(await gh.wire.getDefaultBranch(REPO)).toBe("main");
  });

  it("retries a body that does not parse", async () => {
    const gh = wireOf({ "repos/octo/demo": [answer(200, '{"default_br'), answer(200, { default_branch: "main" })] });

    expect(await gh.wire.getDefaultBranch(REPO)).toBe("main");
  });

  it("retries a body that does not parse unconditionally, though GitHub sent an ETag with it", async () => {
    const gh = wireOf({ "If-None-Match": [answer(304, "")], "repos/octo/demo": [answer(200, '{"default_br', "", '"e1"'), answer(200, { default_branch: "main" })] });

    expect(await gh.wire.getDefaultBranch(REPO)).toBe("main");
    expect(gh.calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const gh = wireOf({ "repos/octo/demo": [answer(403, "", "gh: Forbidden (HTTP 403)"), answer(200, { default_branch: "main" })] });

    await expect(gh.wire.getDefaultBranch(REPO)).rejects.toThrow(/HTTP 403/);
    expect(gh.calls).toHaveLength(1);
  });

  it("a persistent 500 ends with the error named, after three attempts and under ten seconds of waiting", async () => {
    const gh = wireOf({ "repos/octo/demo": [answer(500, "", "gh: HTTP 500")] });

    await expect(gh.wire.getDefaultBranch(REPO)).rejects.toThrow(/gh api -i -X GET failed \(1\): gh: HTTP 500/);
    expect(gh.calls).toHaveLength(3);
    expect(gh.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(10_000);
  });

  it("never repeats a write that failed with HTTP 500", async () => {
    const gh = wireOf({ "pulls/7/merge": [answer(500, "", "gh: HTTP 500")], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    await expect(gh.port.merge(REPO, 7, H1, "squash")).rejects.toThrow(/HTTP 500/);
    expect(gh.calls.filter((call) => call.includes("-X PUT"))).toHaveLength(1);
  });

  it("update-branch retried after an unreadable answer sends the same expected head twice", async () => {
    const gh = wireOf({ "pulls/7/update-branch": [answer(202, "{"), answer(202, { message: "Updating" })], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    expect(await gh.port.updateBranch(REPO, 7, H1)).toEqual({ done: true });
    const puts = gh.calls.filter((call) => call.includes("-X PUT"));
    expect(puts).toHaveLength(2);
    expect(puts[1]).toContain(`expected_head_sha=${H1}`);
  });

  it("update-branch retried after gh's empty-response exit continues", async () => {
    const empty: GhResult = { code: 1, stdout: "", stderr: "unexpected end of JSON input\n" };
    const gh = wireOf({ "pulls/7/update-branch": [empty, answer(202, { message: "Updating" })], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    expect(await gh.port.updateBranch(REPO, 7, H1)).toEqual({ done: true });
  });

  it("update-branch retried after HTTP 502 continues", async () => {
    const gh = wireOf({ "pulls/7/update-branch": [answer(502, "", "gh: Bad Gateway (HTTP 502)"), answer(202, { message: "Updating" })], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    expect(await gh.port.updateBranch(REPO, 7, H1)).toEqual({ done: true });
  });

  it("update-branch whose retry answers 422 head moved reads as already updated", async () => {
    const moved = answer(422, { message: "expected head sha didn't match current head ref." }, "gh: expected head sha didn't match current head ref. (HTTP 422)");
    const gh = wireOf({ "pulls/7/update-branch": [answer(202, "{"), moved], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    expect(await gh.port.updateBranch(REPO, 7, H1)).toEqual({ done: true });
  });

  it("update-branch failing twice rethrows the original error", async () => {
    const gh = wireOf({ "pulls/7/update-branch": [answer(202, "{"), answer(500, "", "gh: HTTP 500")], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    await expect(gh.port.updateBranch(REPO, 7, H1)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("update-branch does not retry a 4xx", async () => {
    const gh = wireOf({ "pulls/7/update-branch": [answer(403, "", "gh: Forbidden (HTTP 403)")], "compare/": [compare], "pulls/7": [answer(200, pull(H1))] });

    await expect(gh.port.updateBranch(REPO, 7, H1)).rejects.toThrow(/HTTP 403/);
    expect(gh.calls.filter((call) => call.includes("-X PUT"))).toHaveLength(1);
  });
});
