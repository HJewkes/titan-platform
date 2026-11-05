import { describe, expect, it } from "vitest";
import type { GhExec } from "./exec.js";
import { fakeSha } from "./fake.js";
import { fakeFetch } from "./fetch-fake.test-helpers.js";
import { ghCliWire } from "./gh-cli.js";
import { octokitClient } from "./octokit-client.js";
import { octokitWire } from "./octokit-wire.js";

const REPO = "octo/demo";
const HEAD = fakeSha("check-run-wire");

/** Shaped like GitHub's check-runs payload: one finished run with an output title, one queued run whose `output` is null. */
const PAGE = {
  total_count: 2,
  check_runs: [
    { id: 1, name: "validate", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:04:10Z", output: { title: "All checks passed", summary: "ok" }, head_sha: HEAD, details_url: "https://github.com/octo/demo/actions/runs/55/job/1", html_url: null, app: { id: 15368 } },
    { id: 2, name: "dag-check", status: "queued", conclusion: null, started_at: null, completed_at: null, output: null, head_sha: HEAD, details_url: null, html_url: null, app: { id: 15368 } },
  ],
};

function ghWire() {
  const exec: GhExec = async () => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(PAGE)}`, stderr: "" });
  return ghCliWire(exec);
}

function restWire() {
  const fake = fakeFetch(() => ({ status: 200, body: PAGE }));
  return octokitWire({ client: octokitClient({ fetch: fake.fetch, token: async () => "test-token", throttleId: "check-run-wire" }) });
}

describe("check-run completion and title", () => {
  it("maps completed_at and output.title onto each run", async () => {
    const runs = await ghWire().listCheckRuns(REPO, HEAD);

    expect(runs.map((run) => [run.name, run.completedAt, run.title])).toEqual([
      ["validate", "2026-01-01T00:04:10Z", "All checks passed"],
      ["dag-check", null, null],
    ]);
  });

  it("reads a run with no output object as having no title, not undefined", async () => {
    const runs = await ghWire().listCheckRuns(REPO, HEAD);

    expect(runs[1]).toHaveProperty("title", null);
    expect(runs[1]).toHaveProperty("completedAt", null);
  });

  it("gives the same runs over the Octokit wire as over gh", async () => {
    const [overGh, overRest] = await Promise.all([ghWire().listCheckRuns(REPO, HEAD), restWire().listCheckRuns(REPO, HEAD)]);

    expect(overRest).toEqual(overGh);
  });
});
