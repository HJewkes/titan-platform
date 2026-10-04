import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { checkPreferences, PREFERENCES } from "./preference.js";
import type { PreferenceContext, PreferenceId } from "./preference.js";

const AGENT: PreferenceContext = { seat: false };
const SEAT: PreferenceContext = { seat: true };

function ids(command: string, ctx: PreferenceContext = AGENT): PreferenceId[] {
  return checkPreferences(extractCommands(command, { cwd: "/home/you/projects/app", home: "/home/you" }), ctx).map((h) => h.id);
}

describe("R86: kill by recorded pid, never by name", () => {
  it.each([
    "pkill -f vite",
    "pkill -9 -f 'storybook dev'",
    "pkill node",
    "killall node",
    'bash -c "pkill -f x"',
    "sh -lc 'pkill -f x'",
    "kill $(pgrep -f vite)",
    "pgrep -f vite | xargs kill",
    "kill -9 $(pidof node)",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R86");
  });

  it.each(["pkill -P 4242", "pkill -TERM -P 4242", "kill 4242", "kill -9 4242", "pgrep -f vite", "kill $(pgrep -P 4242)"])(
    "passes %s",
    (command) => {
      expect(ids(command)).not.toContain("R86");
    },
  );
});

describe("R50: never publish from a session", () => {
  it.each([
    "npm publish",
    "pnpm publish --access public --no-git-checks",
    "pnpm -r publish",
    "yarn npm publish",
    "bun publish",
    "pnpm changeset publish",
    "bash -c 'npm publish'",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R50");
  });

  it.each(["npm publish --dry-run", "pnpm publish --dry-run", "npm pack", "npm view @scope/a versions", "pnpm changeset"])(
    "passes %s",
    (command) => {
      expect(ids(command)).not.toContain("R50");
    },
  );
});

describe("R31: a merge, deploy, branch delete or tag push runs as its own call", () => {
  it.each([
    "gh pr merge 12 --squash && git branch -D feat/x",
    "gh pr merge 12 --squash; gh pr view 12",
    "gh pr merge 12 2>&1 | tail -3",
    "gh pr merge $(gh pr list -q '.[0].number')",
    "pnpm build && wrangler deploy",
    "git branch -d feat/x && git worktree prune",
    "git fetch && git push origin --delete feat/x",
    "git status; git push origin :feat/x",
    "git tag v1.2.0 && git push --tags",
    "git tag v1.2.0 && git push origin refs/tags/v1.2.0",
    "bash -c 'gh pr merge 12 && echo done'",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R31");
  });

  it.each([
    "gh pr merge 12 --squash",
    "cd /home/you/projects/app && gh pr merge 12 --squash",
    "bash -c 'gh pr merge 12'",
    "git branch -D feat/x",
    "git push origin --delete feat/x",
    "git push --tags",
    "git add . && git commit -m wip && git push origin feat/x",
    "git branch --list && git status",
    "git push && git status",
  ])("passes %s", (command) => {
    expect(ids(command)).not.toContain("R31");
  });
});

describe("R127: wait for CI with ci-wait, never poll", () => {
  it.each([
    "gh run watch 123",
    "gh pr checks 12 --watch",
    "gh pr checks --watch --interval 30",
    "until gh pr checks 12; do sleep 30; done",
    "while true; do gh run list -L 1; sleep 20; done",
    "for i in 1 2 3; do gh api repos/o/r/commits/abc/check-runs; sleep 60; done",
    "watch -n 30 gh pr checks 12",
    "bash -c 'sleep 60 && gh pr view 12'",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R127");
  });

  it.each([
    "gh pr checks 12",
    "gh run view 123 --log-failed",
    "gh api repos/o/r/commits/abc/check-runs --jq '.check_runs[].name'",
    "sleep 1 && pnpm test",
    "ci-wait o/r abc123",
    "gh pr view 12 --json body",
  ])("passes %s", (command) => {
    expect(ids(command)).not.toContain("R127");
  });
});

describe("R133: a seat merges only through seat-merge", () => {
  it.each([
    "gh pr merge 12 --squash",
    "gh api -X PUT repos/o/r/pulls/12/merge",
    "curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge",
    "gh pr merge changeset-release/main --squash",
    "git push origin HEAD:main",
  ])("matches %s in a seat", (command) => {
    expect(ids(command, SEAT)).toContain("R133");
  });

  it("passes a raw merge outside a seat", () => {
    expect(ids("gh pr merge 12 --squash", AGENT)).not.toContain("R133");
  });

  it.each(["seat-merge tp o/r 12 abc123 /tmp/clone", "gh pr merge 12 --disable-auto", "gh api repos/o/r/pulls/12/merge", "git push origin feat/x"])(
    "passes %s in a seat",
    (command) => {
      expect(ids(command, SEAT)).not.toContain("R133");
    },
  );
});

describe("R64: active-work tests set ACTIVE_ROOT, never XDG_DATA_HOME", () => {
  it.each([
    "XDG_DATA_HOME=/tmp/x active-work list",
    "env XDG_DATA_HOME=/tmp/x active-work task list",
    "XDG_DATA_HOME=/tmp/x pnpm exec active-work list",
    "bash -c 'XDG_DATA_HOME=/tmp/x active-work list'",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R64");
  });

  it.each(["ACTIVE_ROOT=/tmp/x active-work list", "XDG_DATA_HOME=/tmp/x ACTIVE_ROOT=/tmp/y active-work list", "XDG_DATA_HOME=/tmp/x pnpm test"])(
    "passes %s",
    (command) => {
      expect(ids(command)).not.toContain("R64");
    },
  );
});

describe("R164: never skip hooks", () => {
  it.each([
    "git commit --no-verify -m wip",
    "git commit -n -m wip",
    "git commit -anm wip",
    "git push --no-verify origin feat/x",
    "git merge --no-verify feat/x",
    "git -c core.hooksPath=/dev/null commit -m wip",
    "bash -c 'git commit --no-verify -m wip'",
  ])("matches %s", (command) => {
    expect(ids(command)).toContain("R164");
  });

  it.each([
    'git commit -m "--no-verify is banned"',
    "git push -n origin feat/x",
    "git commit -m wip",
    "gh pr create --body --no-verify",
    "git log -n 5",
  ])("passes %s", (command) => {
    expect(ids(command)).not.toContain("R164");
  });
});

describe("checkPreferences", () => {
  it("reports every broken row once, in table order, with its message", () => {
    const hits = checkPreferences(extractCommands("pkill -f vite && npm publish && pkill -f x"), AGENT);

    expect(hits).toEqual([
      { id: "R86", message: expect.stringContaining("PID") },
      { id: "R50", message: expect.stringContaining("CI") },
      { id: "R31", message: expect.stringContaining("own Bash call") },
    ]);
  });

  it("passes ordinary work", () => {
    expect(ids("pnpm build && pnpm test && git status", SEAT)).toEqual([]);
  });

  it("gives every row a single-sentence message", () => {
    for (const row of PREFERENCES) expect(row.message).toMatch(/^(?:[^.]|\.\S)*\.$/);
  });
});
