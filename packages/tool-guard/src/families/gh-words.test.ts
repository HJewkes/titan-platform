import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { GH_BUILTINS, ghAliasSlot, ghCommandLine } from "./gh-words.js";

function ghLine(line: string) {
  const gh = extractCommands(line, { cwd: "/home/you/projects/app", home: "/home/you" }).filter((c) => c.name === "gh").at(-1);
  if (!gh) throw new Error(`no gh command in ${line}`);
  return ghCommandLine(gh.args);
}

function read(line: string) {
  const { path, leaf, aliasSlot, hidden } = ghLine(`gh ${line}`);
  return { path: path.join(" "), leaf: leaf.map((w) => w.value).join(" "), aliasSlot, hidden };
}

describe("gh command words found the way cobra finds them", () => {
  it.each([
    ["an unknown flag before the group takes the next word", "--squash 7 pr merge", "pr merge", "--squash 7"],
    ["an unknown flag may take a word that names a group", "--squash pr pr merge", "pr merge", "--squash pr"],
    ["an unknown flag between group and verb takes the next word", "pr --squash 7 merge", "pr merge", "--squash 7"],
    ["a short flag takes the next word", "-s 7 pr merge", "pr merge", "-s 7"],
    ["-h takes the next word, as gh defines --help with no shorthand", "pr -h view 1", "pr 1", "-h view"],
    ["a short cluster takes nothing", "-sx pr merge", "pr merge", "-sx"],
    ["an attached value takes nothing", "--repo=o/r pr merge 1", "pr merge", "--repo=o/r 1"],
    ["--help takes nothing", "--help pr merge 1", "pr merge", "--help 1"],
    ["--version takes nothing at the root", "--version pr", "pr", "--version"],
    ["--version takes the next word below the root", "pr --version merge 1", "pr 1", "--version merge"],
    ["-- ends the search", "-- pr merge", "", "-- pr merge"],
    ["an empty word is skipped and kept", "pr '' view 1", "pr view", " 1"],
    ["a command alias reads canonical", "cs list", "codespace list", ""],
    ["a nested group's subcommand", "repo autolink create", "repo autolink create", ""],
    ["a command with no subcommands ends the path", "api repos/o/r/pulls", "api", "repos/o/r/pulls"],
    ["a subcommand alias stays as written", "pr co 5", "pr co", "5"],
    ["a flag with nothing after it", "pr -R", "pr", "-R"],
    ["a subcommand of a second-level group that takes no alias", "codespace ports visibility 80:public", "codespace ports visibility", "80:public"],
    ["an argument of a second-level group that takes no alias", "cs ports 80", "codespace ports", "80"],
  ])("%s: gh %s", (_, line, path, leaf) => {
    expect(read(line)).toMatchObject({ path, leaf, hidden: false });
  });
});

describe("a gh word gh may run as a config alias or an extension", () => {
  it.each([
    ["a top-level word", "m 1", true],
    ["co, which a config alias may shadow", "co 5", true],
    ["a word under a group", "pr x 5", true],
    ["a word under a nested group", "repo autolink zz", true],
    ["a word under a command with no subcommand list", "copilot x", true],
    ["an extension that extension exec runs", "extension exec foo", true],
    ["an extension that ext exec runs", "ext exec foo", true],
    ["an extension after --, which extension exec still hands on", "extension exec -- foo", true],
    ["a run-time word after --, which extension exec still hands on", "extension exec -- $X", true],
    ["a word cobra reads as a flag's value", "extension exec -x foo", true],
    ["extension exec with no extension", "extension exec", true],
    ["an extension after -- that ext exec runs", "ext exec -- foo", true],
    ["a flag's value that extensions exec runs", "extensions exec -x foo", true],
    ["an argument of a group that takes no alias", "codespace ports 80", false],
    ["a sibling of extension exec", "extension list", false],
    ["a subcommand", "pr view 1", false],
    ["a word after a command that takes no alias", "api x", false],
    ["a command with no children", "status", false],
    ["a group alone", "pr", false],
    ["no command word", "--version", false],
  ])("%s: gh %s", (_, line, aliasSlot) => {
    expect(read(line)).toMatchObject({ aliasSlot, hidden: false });
  });

  it.each([...GH_BUILTINS])("does not read the built-in %s as an alias", (word) => {
    expect(ghAliasSlot([word])).toBeUndefined();
  });
});

describe("a gh word cobra may read as a command word that is only known at run time", () => {
  it.each([
    ["the group", "gh $X pr"],
    ["an option word whose width is unknown", "gh --$F x pr merge"],
    ["a swallowed value that may split", "gh -R $R pr merge"],
    ["a case-unsure verb", "declare -u V; V=merge; gh pr $V merge"],
    ["a known value bash splits", 'S="pr merge"; gh $S 1'],
    ["a quoted known value with a blank", 'S="pr merge"; gh "$S" 1'],
    ["a second-level group's subcommand", "gh codespace ports $X"],
    ["a second-level group's subcommand under a command alias", "gh cs ports $X"],
    ["a second-level group's subcommand after a flag's value", "gh codespace ports -c x $X"],
    ["the extension extension exec runs", "gh extension exec $X"],
  ])("is hidden for %s: %s", (_, line) => {
    expect(ghLine(line).hidden).toBe(true);
  });

  it.each([
    ["a quoted swallowed value", '-R "$R" pr view 1'],
    ["an attached quoted value", '--repo="$R" pr view 1'],
    ["a variable past the verb", "pr view $N"],
    ["a variable after a command with no subcommands", "api $X"],
  ])("is known for %s: gh %s", (_, line) => {
    expect(read(line).hidden).toBe(false);
  });
});
