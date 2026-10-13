import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { ghPathUnknown } from "./gh-path.js";

function ghCommand(line: string) {
  const gh = extractCommands(line, { cwd: "/home/you/projects/app", home: "/home/you" }).filter((c) => c.name === "gh").at(-1);
  if (!gh) throw new Error(`no gh command in ${line}`);
  return gh;
}

describe("a gh command path only known at run time", () => {
  it.each([
    ["the group from a variable", "gh $X"],
    ["the group from a quoted variable", 'gh "$X"'],
    ["the group from a braced variable", "gh ${X}"],
    ["the verb from a variable", "gh pr $X"],
    ["the verb from a quoted variable", 'gh pr "$X" 5'],
    ["a verb with a variable suffix", "gh pr merge$X"],
    ["the group unknown before a literal verb", "gh $X merge"],
    ["the release verb", "gh release $X"],
    ["the workflow verb", "gh workflow $X"],
    ["the gist verb", "gh gist $X"],
    ["the group after a repo option", "gh -R o/r $X"],
    ["an unknown option word, which may take the group as its value", "gh -$F pr view"],
    ["an unknown long option word", 'gh "--$O" pr view'],
    ["an unknown long option name with an attached value", 'gh "--$O=x" pr view'],
    ["an unquoted repo value, which may split into the path", "gh -R $R pr view"],
    ["an unquoted attached repo value", "gh --repo=$R pr view"],
    ["the group from a command substitution", "gh $(cat f) merge"],
    ["the verb from a backquote substitution", "gh pr `echo merge` 1"],
    ["a case-unsure verb, which bash 5 may upper-case", "declare -u V; V=merge; gh pr $V"],
    ["a known value bash splits into the group and verb", 'X="pr merge"; gh $X 1'],
    ["the same value quoted, which no gh group matches", 'X="pr merge"; gh "$X" 1'],
    ["a known repo value bash splits into the path", 'R="o/r pr merge"; gh -R $R 1'],
    ["a verb after a long flag the group level reads as taking a value", "gh pr --body x $V 1"],
    ["a verb after a short flag the group level reads as taking a value", "gh pr -b x $V 1"],
    ["a group after a flag the root reads as taking a value", "gh --body x $G merge 1"],
    ["a group after a cluster ending in R, which cobra reads as one word", 'gh -bR "$V" merge 1'],
    ["a verb after a cluster ending in R", 'gh pr -bR "$V" 1'],
    ["a verb after an empty word, which cobra drops", "gh pr '' \"$V\""],
    ["a group after a lone dash, which cobra drops", 'gh - "$X" create f'],
    ["a group after an empty word, which cobra drops", "gh '' \"$X\" merge 1"],
    ["a group after an empty double-quoted word", 'gh "" "$G"'],
    ["a variable where gh may run an alias under a group", "gh run $X"],
    ["a variable after -h, which takes the next word in cobra", "gh pr -h view $N"],
    ["a group after an unknown flag whose value may split", "gh --x $Y pr view"],
    ["a top-level alias or extension", "gh m"],
    ["a top-level alias with an argument", "gh m 1"],
    ["co, which a config alias may shadow", "gh co 5"],
    ["help, which a config alias may shadow", "gh help pr"],
    ["a word under a group that is not one of its subcommands", "gh pr x 5"],
    ["a word under a nested group that is not one of its subcommands", "gh repo autolink zz"],
    ["a flag that takes the verb, leaving the number as the alias slot", "gh pr --web view 1"],
    ["a config directory prefix", "GH_CONFIG_DIR=/c gh pr view 1"],
    ["an XDG config prefix", "XDG_CONFIG_HOME=/c gh pr view 1"],
    ["a home prefix", "HOME=/h gh pr view 1"],
    ["a config directory set through env", "env GH_CONFIG_DIR=/c gh pr view 1"],
  ])("is unknown for %s: %s", (_, line) => {
    expect(ghPathUnknown(ghCommand(line))).toBe(true);
  });
});

describe("a gh command path known as written", () => {
  it.each([
    ["a literal path", "gh pr view 1"],
    ["a variable past the verb", "gh pr view $N"],
    ["a quoted repo value", 'gh -R "$R" pr view 1'],
    ["a quoted attached repo value", 'gh --repo="$R" pr view 1'],
    ["an attached short repo value", 'gh -R"$R" pr view 1'],
    ["a run id", "gh run view $ID"],
    ["an api endpoint from a variable", "gh api $X"],
    ["an api endpoint with a variable", "gh api repos/$R/pulls"],
    ["a workflow target, not its verb", 'gh workflow run "$W"'],
    ["a flag value past the verb", 'gh pr create --title "$T"'],
    ["a literal merge", "gh pr merge 12 --squash"],
    ["a literal release", "gh release create v1"],
    ["a literal gist", "gh gist create f"],
    ["a literal option before the group", "gh --help pr view"],
    ["a flag either reading leaves a known path after", "gh pr --body x view 1"],
    ["an attached long value", "gh pr --body=x view 1"],
    ["a short cluster with a known path either way", "gh pr -bx view 1"],
    ["a repo option before the group", "gh -R o/r pr view 1"],
    ["a list", "gh pr list"],
    ["checks on a variable", "gh pr checks $N"],
    ["a run list", "gh run list -L 5"],
    ["an empty word with a known path either way", "gh pr '' view 1"],
    ["sixty flags, each taking the next", `gh ${"-a ".repeat(60)}pr view 1`],
    ["a variable after --, which cobra never reads as a command word", "gh -- $X"],
    ["an option-shaped variable after --", "gh -- -$F"],
    ["a verb after a flag that takes a quoted value", 'gh pr --body "$B" merge 1'],
    ["an unknown root flag that takes the next word", "gh --foo x pr view 1"],
    ["a squash flag before the group taking the PR number", "gh --squash 7 pr merge"],
    ["a command alias of a group", "gh cs list"],
    ["a nested group's subcommand", "gh repo autolink create"],
    ["an alias list", "gh alias list"],
    ["an extension list", "gh extension list"],
    ["the version flag", "gh --version"],
    ["a command with no alias children", "gh status x"],
  ])("is known for %s: %s", (_, line) => {
    expect(ghPathUnknown(ghCommand(line))).toBe(false);
  });
});
