import { describe, expect, it } from "vitest";
import { commandCwd, commandHeads, parseGitIntent, parsePrCreateTitle, parseTaskId, parseTaskIntent, parseTaskIntents, realCommand } from "./bash-parse.js";

describe("parseGitIntent", () => {
  it("captures a new branch with its start point, plus commit and push", () => {
    expect(parseGitIntent("git checkout -b feat/x main && git commit -m y && git push -u origin feat/x")).toEqual({
      setBranch: "feat/x",
      branchBase: "main",
      deletedBranch: null,
      mergedPr: null,
      commit: true,
      push: true,
    });
  });

  it("does not read a start point across a newline or from a heredoc", () => {
    expect(parseGitIntent("git checkout -b feat/x\ngit add -A")?.branchBase).toBeNull();
    expect(parseGitIntent("git checkout -b feat/x <<'EOF'\nmain\nEOF")?.branchBase).toBeNull();
  });

  it("reads gh pr create head and base, merges, and deletions", () => {
    expect(parseGitIntent("gh pr create --head feat/y --base develop --title t")).toMatchObject({ setBranch: "feat/y", branchBase: "develop" });
    expect(parseGitIntent("gh pr merge 42 --squash")?.mergedPr).toBe(42);
    expect(parseGitIntent("git branch -D old/thing")?.deletedBranch).toBe("old/thing");
    expect(parseGitIntent("ls -la")).toBeNull();
  });
});

describe("shell helpers", () => {
  it("strips leading cd prefixes and resolves the command's cwd", () => {
    expect(realCommand("cd /tmp && cd sub; aw task done x AW-1")).toBe("aw task done x AW-1");
    expect(commandCwd("cd /repo && git checkout -b x", "/elsewhere")).toBe("/repo");
    expect(commandCwd("git -C /other status", "/elsewhere")).toBe("/other");
    expect(commandCwd("git status", "/elsewhere")).toBe("/elsewhere");
  });

  it("extracts PR titles with shell unescaping and task ids only from aw commands", () => {
    expect(parsePrCreateTitle('gh pr create --title "Fix \\`thing\\`" --body x')).toBe("Fix `thing`");
    expect(parsePrCreateTitle("gh pr create --title 'raw \\ title'")).toBe("raw \\ title");
    expect(parseTaskId("aw task done demo AW-23")).toBe("AW-23");
    expect(parseTaskId("echo AW-23")).toBeNull();
  });
});

describe("parseTaskIntent", () => {
  it("reads done as a status", () => {
    expect(parseTaskIntent("active-work task done demo AW-23")).toEqual({ taskId: "AW-23", status: "done" });
    expect(parseTaskIntent("aw task done demo AW-23 2>&1 | tail -3")).toEqual({ taskId: "AW-23", status: "done" });
  });

  it("reads an explicit status edit, and only when the field is status", () => {
    expect(parseTaskIntent("active-work task edit demo AW-23 status blocked")).toEqual({ taskId: "AW-23", status: "blocked" });
    expect(parseTaskIntent("active-work task edit demo AW-23 notes done")).toEqual({ taskId: "AW-23", status: null });
    expect(parseTaskIntent("active-work task edit demo AW-23 title done")).toEqual({ taskId: "AW-23", status: null });
  });

  it("names the task but claims no status for a read", () => {
    expect(parseTaskIntent("active-work task list demo AW-23")).toEqual({ taskId: "AW-23", status: null });
    expect(parseTaskIntent("aw task show demo AW-23")).toEqual({ taskId: "AW-23", status: null });
  });

  it("ignores commands that are not active-work, or that name no task", () => {
    expect(parseTaskIntent("echo AW-23")).toBeNull();
    expect(parseTaskIntent("gh pr merge 12 AW-23")).toBeNull();
    expect(parseTaskIntent("active-work task add demo --title x")).toBeNull();
  });

  it("does not mistake the word done elsewhere in the line for a status", () => {
    expect(parseTaskIntent("active-work task list demo | grep done AW-23")).toBeNull();
  });

  it("finds the invocation at the tail of a compound chain, the dominant real shape", () => {
    const real =
      'cd ~/projects/titan-platform && gh pr merge 5 --squash 2>&1 | tail -1; git checkout -q main && cd "/Users/x/active-work/titan-platform" && active-work task done titan-platform TP-5';
    expect(parseTaskIntents(real)).toEqual([{ taskId: "TP-5", status: "done" }]);
  });

  it("returns every task a chain closes, not just the first", () => {
    expect(parseTaskIntents("active-work task done demo AW-1 && active-work task done demo AW-2")).toEqual([
      { taskId: "AW-1", status: "done" },
      { taskId: "AW-2", status: "done" },
    ]);
  });

  it("prefers the status-bearing mention when one chain both reads and closes a task", () => {
    expect(parseTaskIntents("active-work task list demo AW-1 && active-work task done demo AW-1")).toEqual([{ taskId: "AW-1", status: "done" }]);
    expect(parseTaskIntents("active-work task done demo AW-1 && active-work task list demo AW-1")).toEqual([{ taskId: "AW-1", status: "done" }]);
  });

  it("does not read a status across a command boundary", () => {
    expect(parseTaskIntents("active-work task edit demo AW-1 notes x; echo status done")).toEqual([{ taskId: "AW-1", status: null }]);
  });
});

describe("commandHeads", () => {
  it("drops cd, splits every separator and turns an append target into its parent and basename", () => {
    expect(commandHeads("cd /tmp/repo && gh pr checks 5; echo y >> /tmp/state/log.jsonl")).toEqual(["gh pr checks", "echo", ">state/log.jsonl"]);
    expect(commandHeads("git log --oneline | head -5 || true\nactive-work task edit demo TP-1 status done")).toEqual(["git log", "head", "true", "active-work task edit"]);
  });

  it("drops cd even when its directory looks like a subcommand", () => {
    expect(commandHeads("cd /a && ls; cd b; git status")).toEqual(["ls", "git status"]);
  });

  it("drops the closing subshell paren from the last word", () => {
    expect(commandHeads("(cd b && ls)")).toEqual(["ls"]);
  });

  it("looks through builtin and command to the program word", () => {
    expect(commandHeads("builtin cd x; ls")).toEqual(["ls"]);
    expect(commandHeads("command cd x; ls")).toEqual(["ls"]);
  });

  it("gives command -v a head without throwing", () => {
    expect(commandHeads("command -v git")).toEqual(["git"]);
  });

  it("does not close a command substitution on a quoted paren", () => {
    expect(commandHeads("echo $(echo ')' && x) && ls")).toEqual(["echo", "ls"]);
  });

  it("keeps a quoted separator inside one head", () => {
    expect(commandHeads('git commit -m "a && b; c | d"')).toEqual(["git commit"]);
  });

  it("treats an fd dup as no target and a tee file as one", () => {
    expect(commandHeads("pnpm test 2>&1 | tee -a out/run.log")).toEqual(["pnpm test", "tee", ">out/run.log"]);
    expect(commandHeads("make build > /dev/null 2>&1")).toEqual(["make build"]);
  });

  it("skips heredoc bodies, env assignments and repeated heads", () => {
    expect(commandHeads("cat > notes.md <<'EOF'\nrm -rf x && y\nEOF\nCI=1 pnpm lint && pnpm lint")).toEqual(["cat", ">notes.md", "pnpm lint"]);
  });

  it("keeps the parent directory of a dated redirect target and leaves a bare filename alone", () => {
    expect(commandHeads("echo x >> logs/a/$(date +%F).md")).toEqual(["echo", ">a/$(date +%F).md"]);
    expect(commandHeads("echo x > ./notes.md; echo y > /out.md")).toEqual(["echo", ">notes.md", ">out.md"]);
  });

  it("gives gh api the method and resource shape, dropping owner, repo, ids and flag values", () => {
    expect(commandHeads("gh api -X PUT repos/o/r/pulls/5/merge")).toEqual(["gh api PUT pulls/merge"]);
    expect(commandHeads("gh api repos/o/r/commits/abc/check-runs --jq '.check_runs[]|.name'")).toEqual(["gh api GET commits/check-runs"]);
    expect(commandHeads("gh api --method=patch /repos/{owner}/{repo}/issues/7 -f state=closed -H 'Accept: x'")).toEqual(["gh api PATCH issues"]);
    expect(commandHeads('gh api "repos/$REPO/pulls?per_page=100" --paginate')).toEqual(["gh api GET pulls"]);
  });

  it("gives gh api POST when a field adds a body and no method is named", () => {
    expect(commandHeads("gh api repos/o/r/issues/5/comments -f body=hello")).toEqual(["gh api POST issues/comments"]);
    expect(commandHeads("gh api repos/o/r")).toEqual(["gh api GET repos"]);
  });

  it("keeps an interpreter's script basename only when its first operand looks like a file", () => {
    expect(commandHeads("python3 /x/y/score.py --seat a")).toEqual(["python3 score.py"]);
    expect(commandHeads("node dist/cli.js; bash run.sh; bash -x ./deploy")).toEqual(["node cli.js", "bash run.sh", "bash deploy"]);
    expect(commandHeads("python3 -c 'print(1)'; python3 - <<EOF\nimport x\nEOF")).toEqual(["python3"]);
    expect(commandHeads("python3 -m http.server; bun run build; node $ENTRY")).toEqual(["python3", "bun run build", "node"]);
  });

  it("looks through timeout, nice, nohup and env to the program they run", () => {
    expect(commandHeads("timeout 60 python3 s.py")).toEqual(["python3 s.py"]);
    expect(commandHeads("timeout -s KILL 5m nice -n 10 git status")).toEqual(["git status"]);
    expect(commandHeads("nohup env -u X CI=1 pnpm test &")).toEqual(["pnpm test"]);
  });
});
