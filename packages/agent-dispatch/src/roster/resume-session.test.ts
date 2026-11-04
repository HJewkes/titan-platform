import { describe, expect, it } from "vitest";
import {
  describeResume,
  identityBlocker,
  missingAgent,
  resumeBlocker,
} from "./resume-session.js";
import type { AgentIdentity } from "./types.js";

/** CC-126 and CC-1472: the decisions a resume makes before anything launches. */

const agent = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: "a1",
  name: "scout",
  profile: "explorer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "human",
  spawnedAt: 1,
  brief: "",
  cwd: "/work/ws",
  isolation: "none",
  surface: "headless",
  sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  lastEventAt: 1,
  generation: 1,
  ...over,
});

const present = { path: "/cfg/projects/ws/s.jsonl", found: true };
const gone = { path: "/cfg/projects/ws/s.jsonl", found: false };
const dirExists = (): boolean => true;
const dirMissing = (): boolean => false;

describe("refusing a resume", () => {
  it("refuses to resume a retired agent whose transcript is gone", () => {
    expect(resumeBlocker(agent({ state: "retired" }), gone, dirExists)).toMatch(
      /transcript is gone/
    );
  });

  it("resumes a retired agent whose transcript is found", () => {
    expect(
      resumeBlocker(agent({ state: "retired" }), present, dirExists)
    ).toBeUndefined();
  });

  it("refuses a live agent before looking at its transcript", () => {
    expect(resumeBlocker(agent({ state: "live" }), gone, dirExists)).toMatch(
      /already live/
    );
  });

  it("refuses an agent with no recorded session id", () => {
    expect(identityBlocker(agent({ sessionId: "" }))).toMatch(
      /no recorded session id/
    );
  });

  it("refuses when the working directory is gone and no worktree can come back", () => {
    expect(resumeBlocker(agent(), present, dirMissing)).toMatch(
      /no longer exists/
    );
  });

  it("resumes into a gone working directory when its worktree is re-created", () => {
    const tree = { gitRoot: "/work/repo", worktree: "/work/ws", branch: "b" };

    expect(resumeBlocker(agent(), present, dirMissing, tree)).toBeUndefined();
  });
});

describe("pointing a retired name at the spawn route", () => {
  it("names the session and the cwd to spawn with", () => {
    const text = missingAgent("scout", agent({ state: "retired" }));

    expect(text).toContain(
      'resume_session="0f8fad5b-d9cb-469f-a165-70867728950e"'
    );
    expect(text).toContain('cwd="/work/ws"');
  });

  it("names the repository when the removed worktree is re-created", () => {
    const text = missingAgent("scout", agent({ state: "retired" }), {
      gitRoot: "/work/repo",
      worktree: "/work/ws",
      branch: "b",
    });

    expect(text).toContain('isolation="worktree" and cwd="/work/repo"');
  });

  it("says only that a name nothing held is unknown", () => {
    expect(missingAgent("nobody", undefined)).toBe('no agent named "nobody"');
  });
});

describe("the reply to a resume", () => {
  it("leads a refusal with its reason and says where the transcript was looked for", () => {
    expect(
      describeResume("scout", { ok: false, reason: "gone", transcript: gone })
    ).toEqual({
      ok: false,
      lines: [
        "Not resumed: gone",
        "no transcript found at /cfg/projects/ws/s.jsonl",
      ],
    });
  });

  it("says a retried resume was not launched again", () => {
    const { lines } = describeResume("scout", {
      ok: true,
      deduped: true,
      host: "box",
      transcript: present,
    });

    expect(lines[0]).toMatch(/already ran/);
    expect(lines[1]).toContain("Resumed scout on box");
  });
});
