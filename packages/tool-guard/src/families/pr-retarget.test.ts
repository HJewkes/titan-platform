import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import type { SimpleCommand } from "../shell/commands.js";
import { apiPullRetarget, prEditRetarget } from "./pr-retarget.js";

function lastCommand(line: string): SimpleCommand {
  const cmd = extractCommands(line, { home: "/home/you" }).at(-1);
  if (!cmd) throw new Error(`no command in: ${line}`);
  return cmd;
}

describe("prEditRetarget", () => {
  it.each([
    ["gh pr edit 12 --base main", { pr: "12", base: "main" }],
    ["gh pr edit 12 -B main", { pr: "12", base: "main" }],
    ["gh pr edit 12 -Bmain", { pr: "12", base: "main" }],
    ["gh pr edit 12 -B=main", { pr: "12", base: "main" }],
    ["gh pr edit 12 --base=main", { pr: "12", base: "main" }],
    ["gh pr edit --base feat/x --base main", { pr: null, base: "main" }],
    ['gh pr edit 12 --base "$B"', { pr: "12", base: "unknown" }],
    ["gh pr edit 12 $FLAGS", { pr: "12", base: "unknown" }],
    ['gh pr edit "$F" --title x', { pr: null, base: "unknown" }],
    ["gh pr edit 12 --title $T", { pr: "12", base: "unknown" }],
    ["gh -R o/r pr edit 12 --base main", { pr: "12", base: "main" }],
    ["gh pr edit -R o/r 12 --base main", { pr: "12", base: "main" }],
    ["gh pr edit https://github.com/o/r/pull/12 --base feat/parent", { pr: "https://github.com/o/r/pull/12", base: "feat/parent" }],
    ["gh $G pr edit 12 --base main", { pr: null, base: "unknown" }],
  ])("%s retargets", (line, expected) => {
    expect(prEditRetarget(lastCommand(line))).toEqual(expected);
  });

  it.each([
    ["gh pr edit 12 -b 'move to --base main'"],
    ["gh pr edit 12 --title x"],
    ['gh pr edit 12 --title "$T"'],
    ["gh pr create --base main"],
    ["gh pr merge 12"],
    ["gh $G pr create --base main"],
    ["git pr edit 12 --base main"],
  ])("%s does not retarget", (line) => {
    expect(prEditRetarget(lastCommand(line))).toBeNull();
  });
});

describe("apiPullRetarget", () => {
  it.each([
    ["gh api -X PATCH repos/o/r/pulls/12 -f base=main", { pr: "12", base: "main" }],
    ["gh api repos/{owner}/{repo}/pulls/12 --method=PATCH -F base=main", { pr: "12", base: "main" }],
    ["gh api repos/o/r/pulls/12 -f base=main", { pr: "12", base: "main" }],
    ["gh api -X PATCH repos/o/r/pulls/12 -f base=feat/x -f base=main", { pr: "12", base: "main" }],
    ["gh api -X PATCH repos/o/r/pulls/12 --input body.json", { pr: "12", base: "unknown" }],
    ["gh api -X PATCH repos/o/r/pulls/12 -F base=@b.txt", { pr: "12", base: "unknown" }],
    ['gh api -X PATCH repos/o/r/pulls/12 -f "base=$B"', { pr: "12", base: "unknown" }],
    ["gh api -X PATCH 'repos/o/r/pulls/12?base=main'", { pr: "12", base: "main" }],
    ['gh api -X PATCH repos/o/r/pulls/12 -f "$K=main"', { pr: "12", base: "unknown" }],
    ['gh api -X "$M" repos/o/r/pulls/12 -f base=main', { pr: "12", base: "main" }],
    ["gh api -X PATCH https://api.github.com/repos/o/r/pulls/12 -f base=main", { pr: "12", base: "main" }],
    ["gh api -X PATCH api/v3/repos/o/r/pulls/12/ -f base=main", { pr: "12", base: "main" }],
    ['gh api -X PATCH "repos/o/r/pulls/$N" -f base=main', { pr: null, base: "main" }],
  ])("%s retargets", (line, expected) => {
    expect(apiPullRetarget(lastCommand(line))).toEqual(expected);
  });

  it.each([
    ["gh api repos/o/r/pulls/12"],
    ["gh api -X GET repos/o/r/pulls/12 -f base=main"],
    ["gh api -X PATCH repos/o/r/pulls/12 -f title=x"],
    ['gh api -X PATCH repos/o/r/pulls/12 -f "title=$T"'],
    ["gh api -X PATCH repos/o/r/pulls/12/merge -f base=main"],
    ["gh api -X PUT repos/o/r/pulls/12/merge"],
    ["gh api repos/o/r/pulls -f base=main -f head=x -f title=t"],
    ["gh api -X PATCH repos/o/r/issues/12 -f base=main"],
    ['gh api -X PATCH "$E" -f title=x'],
    ["gh pr edit 12 --base main"],
  ])("%s does not retarget", (line) => {
    expect(apiPullRetarget(lastCommand(line))).toBeNull();
  });
});
