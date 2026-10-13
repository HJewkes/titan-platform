import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { appendCallFile, loggedGitHubPort, type GhCallLine } from "./gh-call-log.js";

const pull = (number: number): PullRequest => ({
  number,
  state: "open",
  merged: false,
  mergeSha: null,
  mergedAt: null,
  headRef: `feat/${number}`,
  headSha: "a".repeat(40),
  headRepo: "HJewkes/agent-chat",
  baseRef: "main",
  draft: false,
  mergeableState: "clean",
  behind: false,
  autoMerge: false,
});

function stubPort(getPr: GitHubPort["getPr"]): Pick<GitHubPort, "getPr" | "defaultBranch"> {
  return { getPr, defaultBranch: async () => "main" };
}

function ticking(start: number, step: number): () => number {
  let t = start - step;
  return () => (t += step);
}

describe("session-miner gh-call-log", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("writes one line per getPr and returns the port's results unchanged", async () => {
    const lines: GhCallLine[] = [];
    const port = loggedGitHubPort(stubPort(async (_repo, number) => pull(number)), (line) => lines.push(line), ticking(Date.parse("2026-10-12T16:48:00Z"), 40));

    const results = [await port.getPr("HJewkes/agent-chat", 755), await port.getPr("HJewkes/agent-chat", 756)];

    expect(results).toEqual([pull(755), pull(756)]);
    expect(lines).toEqual([
      { v: 1, at: "2026-10-12T16:48:00.040Z", caller: "session-miner", api: "rest", method: "GET", route: "repos/{o}/{r}/pulls/{n}", status: "ok", ms: 40, remaining: null, resource: null },
      { v: 1, at: "2026-10-12T16:48:00.120Z", caller: "session-miner", api: "rest", method: "GET", route: "repos/{o}/{r}/pulls/{n}", status: "ok", ms: 40, remaining: null, resource: null },
    ]);
    expect(await port.defaultBranch("HJewkes/agent-chat")).toBe("main");
  });

  it("logs a failed read with its HTTP status before rethrowing the same error", async () => {
    const lines: GhCallLine[] = [];
    const refused = Object.assign(new Error("HTTP 403"), { status: 403 });
    const port = loggedGitHubPort(stubPort(async () => { throw refused; }), (line) => lines.push(line));

    await expect(port.getPr("HJewkes/agent-chat", 1)).rejects.toBe(refused);
    expect(lines.map((l) => l.status)).toEqual([403]);
  });

  it("appends to the day's file and prunes days past the seventh", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "gh-calls-"));
    writeFileSync(path.join(dir, "2026-10-05.jsonl"), "");
    writeFileSync(path.join(dir, "2026-10-06.jsonl"), "");
    const line: GhCallLine = { v: 1, at: "2026-10-12T00:00:01.000Z", caller: "session-miner", api: "rest", method: "GET", route: "repos/{o}/{r}/pulls/{n}", status: "ok", ms: 5, remaining: null, resource: null };

    appendCallFile(dir)(line);

    expect(JSON.parse(readFileSync(path.join(dir, "2026-10-12.jsonl"), "utf8"))).toEqual(line);
    expect(existsSync(path.join(dir, "2026-10-05.jsonl"))).toBe(false);
    expect(existsSync(path.join(dir, "2026-10-06.jsonl"))).toBe(true);
  });
});
