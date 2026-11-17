import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { inboxReadCache } from "./inbox-rows.js";
import { inboxViewCommands, warmShownRows, type WatchRow } from "./inbox-view.js";
import type { ConsoleContext } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import { shipLineageReader, type LineageReader, type ShipLineage } from "./ship-lineage.js";

const RUN = "11111111-0000-4000-8000-000000000001";
const SHA = "1234567890abcdef1234567890abcdef12345678";
const BASE = "abcdef1234567890abcdef1234567890abcdef12";
const KNOWN: ShipLineage = { known: true, provenSha: SHA, state: "open", merged: false, mergeSha: null, headSha: SHA, baseRef: "main", baseSha: BASE, behind: 0 };
const OWNER_CONTEXT: ConsoleContext = {
  warnings: [],
  format: "json",
  surface: "http",
  auth: { credential: "session", issuedAt: 1_000, peerLocal: false } satisfies RequestAuth,
  ownerWrites: true,
};

/** A merge gate the inbox shows, joined to a live Shepherd row at a pinned head. */
const GATE: OwnerItem = {
  id: `gate:${RUN}/approve-merge`, sources: [{ system: "hitl", ref: `${RUN}/approve-merge` }], kind: "approve", door: "two-way", summary: "Merge the fixture PR?",
  context: "Synthetic.", keys: [], asker: "test-asker", personal: false, lens: "blocking-agent", unblocks: [], openedAt: "2031-03-04T12:00:00.000Z", status: "open",
};

const LIVE_ROW: WatchRow = {
  repo: "example/repo", pr: 7, branch: "feat/x", runId: RUN, task: "example/EX-1", phase: "approve", headSha: SHA, phaseSince: "2031-03-04T12:00:00.000Z",
  nextAction: "approve-merge", pendingGate: { gateId: `${RUN}/approve-merge`, stepId: "approve-merge", since: "2031-03-04T12:00:00.000Z" }, held: null, stalled: null,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-inbox-first-read-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function inboxSources(lineage: LineageReader) {
  const shepherd = partialFake<ShepherdSource>({
    list: (state) => Promise.resolve(state === "active" ? [LIVE_ROW] : []),
    waiting: () => Promise.resolve({ owner: [], seat: [] }),
    timeline: () => Promise.resolve({ row: LIVE_ROW, entries: [] }),
    checkRuns: () => Promise.resolve({ total_count: 0, check_runs: [] }),
  });
  return { factory: { list: () => Promise.resolve({ items: [GATE], gaps: [] }) }, shepherd, rounds: { dir: path.join(root, "rounds"), lineage }, inbox: { dir: path.join(root, "inbox") } };
}

describe("the inbox's first read after a restart", () => {
  it("waits on no GitHub read for a merge row's lineage once the primer read the shown rows", async () => {
    const github = { hang: false, reads: 0 };
    const sources = inboxSources(() => {
      github.reads += 1;
      return github.hang ? new Promise(() => undefined) : Promise.resolve(KNOWN);
    });
    const cache = inboxReadCache(sources);
    await warmShownRows(sources, cache);
    github.hang = true;

    const { envelope } = await invokeCommand(inboxViewCommands(sources, cache)["inbox.list"], {}, OWNER_CONTEXT);

    expect(envelope).toMatchObject({ ok: true, data: { items: [{ id: GATE.id, lineage: KNOWN }] } });
    expect(github.reads).toBe(1);
  }, 3_000);

  it("leaves a perf row for each GitHub call a lineage makes, so a read waiting on them shows why", async () => {
    const pull: PullRequest = {
      number: 7, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "feat/x", headSha: SHA, headRepo: "example/repo",
      baseRef: "main", draft: false, mergeableState: "clean", behind: false, behindBy: 0, autoMerge: false,
    };
    const port = partialFake<GitHubPort>({ getPr: () => Promise.resolve(pull), getHeadSha: () => Promise.resolve(BASE) });
    const rows: Array<{ name: string; outcome: string }> = [];
    const read = shipLineageReader({ github: port, recorder: { recordUpstream: ({ name, outcome }) => void rows.push({ name, outcome }) } });

    await read({ repo: "example/repo", pr: 7, headSha: SHA });

    expect(rows).toEqual([{ name: "github:getPr", outcome: "ok" }, { name: "github:getHeadSha", outcome: "ok" }]);
  });
});
