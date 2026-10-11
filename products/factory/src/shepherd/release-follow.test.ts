import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import type { FixTaskFields, FixTasks } from "./main-red.js";
import { RELEASE_FOLLOW_TIMEOUT_MS, findReleaseRun, followRelease, npmVersionRegistry, type ReleaseFollowDeps, type VersionRegistry } from "./release-follow.js";

const REPO = "octo/demo";
const MERGE = fakeSha("release-merge");
const VERSIONS = { "@demo/widget": "1.2.0", "@demo/gadget": "0.4.0" };
const FIRST_PACKAGE = "@demo/widget";
const POLL_MS = 1_000;
const signal = new AbortController().signal;

interface Rig {
  fake: FakeGitHub;
  deps: ReleaseFollowDeps;
  added: { initiative: string; fields: FixTaskFields }[];
  polls: () => number;
}

function memoryTasks(added: Rig["added"]): FixTasks {
  return {
    findByTag: async (initiative, tag) => {
      const index = added.findIndex((entry) => entry.initiative === initiative && entry.fields.tags.includes(tag));
      return index === -1 ? undefined : `FX-${index + 1}`;
    },
    add: async (initiative, fields) => `FX-${added.push({ initiative, fields })}`,
  };
}

/** npm serves every version from poll `fromPoll` on; before that it answers 404. */
function rig(fromPoll = 1, onSleep: (fake: FakeGitHub) => void = () => {}): Rig {
  const fake = fakeGitHub();
  const added: Rig["added"] = [];
  let clock = 0;
  let polls = 0;
  const registry: VersionRegistry = async (name) => {
    if (name === FIRST_PACKAGE) polls += 1;
    return polls >= fromPoll;
  };
  const sleep = async (ms: number) => {
    clock += ms;
    onSleep(fake);
  };
  const deps: ReleaseFollowDeps = { port: githubPort(fake.wire), registry, tasks: memoryTasks(added), now: () => clock, sleep, pollMs: POLL_MS };
  return { fake, deps, added, polls: () => polls };
}

const releaseJob = (conclusion: string | null, status = "completed") => ({ ...successRun("release", 9, undefined, conclusion ?? "success"), status, conclusion });
const follow = (r: Rig, versions: Record<string, string> = VERSIONS) => followRelease(r.deps, { repo: REPO, pr: 12, mergeSha: MERGE, versions, task: "demo/TP-1" }, signal);

describe("followRelease", () => {
  it("resolves published with every version once the release job succeeds and npm serves them on the third poll", async () => {
    const r = rig(3, (fake) => fake.setRuns(MERGE, [releaseJob("success")]));
    r.fake.setRuns(MERGE, [releaseJob(null, "in_progress")]);

    const result = await follow(r);

    expect(result).toMatchObject({ outcome: "published", versions: VERSIONS, missing: [], task: null, releaseRun: { id: 9, conclusion: "success" } });
    expect(r.polls()).toBe(3);
  });

  it("files one release-red fix task when the job fails, and a repeat follow finds it instead of filing another", async () => {
    const r = rig(Number.POSITIVE_INFINITY);
    r.fake.setRuns(MERGE, [releaseJob("failure")]);

    const first = await follow(r);
    const second = await follow(r);

    expect(first).toMatchObject({ outcome: "failed", task: "demo/FX-1", missing: ["@demo/widget@1.2.0", "@demo/gadget@0.4.0"] });
    expect(second.task).toBe("demo/FX-1");
    expect(r.added).toHaveLength(1);
    expect(r.added[0]?.fields.tags).toContain(`release-red:${REPO}:${MERGE}`);
  });

  it("ends as a recorded timeout, filing nothing, when npm never serves a version", async () => {
    const r = rig(Number.POSITIVE_INFINITY);
    r.fake.setRuns(MERGE, [releaseJob("success")]);

    const result = await follow(r);

    expect(result).toMatchObject({ outcome: "timeout", task: null, missing: ["@demo/widget@1.2.0", "@demo/gadget@0.4.0"] });
    expect(r.added).toEqual([]);
    expect(r.polls()).toBe(RELEASE_FOLLOW_TIMEOUT_MS / POLL_MS + 1);
  });

  it("follows npm alone when a newer push skipped the job, and resolves once the versions appear", async () => {
    const r = rig(4);
    r.fake.setRuns(MERGE, [releaseJob("skipped")]);

    const result = await follow(r);

    expect(result).toMatchObject({ outcome: "published", releaseRun: { conclusion: "skipped" }, task: null });
    expect(r.added).toEqual([]);
  });

  it("does nothing, and reads no GitHub, for a release that bumped no public package", async () => {
    const r = rig();
    const checkRuns = vi.fn(r.deps.port.checkRuns);
    r.deps.port = { ...r.deps.port, checkRuns };

    const result = await follow(r, {});

    expect(result.outcome).toBe("nothing");
    expect(checkRuns).not.toHaveBeenCalled();
  });
});

describe("findReleaseRun", () => {
  it("finds the Actions release job and ignores a same-named check from another app", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("release", 3, undefined, "success", 77), successRun("validate", 4), successRun("release", 5)]);

    expect((await findReleaseRun(githubPort(fake.wire), REPO, MERGE))?.id).toBe(5);
  });
});

describe("npmVersionRegistry", () => {
  it("reads a scoped name@version: 200 serves it, 404 does not, anything else throws", async () => {
    const urls: string[] = [];
    const answer = (status: number) => npmVersionRegistry(async (url) => (urls.push(String(url)), new Response(null, { status })));

    expect(await answer(200)("@demo/widget", "1.2.0")).toBe(true);
    expect(await answer(404)("@demo/widget", "1.2.0")).toBe(false);
    await expect(answer(503)("@demo/widget", "1.2.0")).rejects.toThrow("503");
    expect(urls[0]).toBe("https://registry.npmjs.org/@demo%2fwidget/1.2.0");
  });
});
