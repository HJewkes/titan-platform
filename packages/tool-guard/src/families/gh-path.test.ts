import { describe, expect, it } from "vitest";
import { extractCommands } from "../shell/commands.js";
import { ghPathUnknown } from "./gh-path.js";

function ghArgs(line: string) {
  const gh = extractCommands(line, { cwd: "/home/you/projects/app", home: "/home/you" }).filter((c) => c.name === "gh").at(-1);
  if (!gh) throw new Error(`no gh command in ${line}`);
  return gh.args;
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
    ["the group after --", "gh -- $X"],
    ["an option-shaped unknown word after --, which is a path word", "gh -- -$F"],
    ["the group from a command substitution", "gh $(cat f) merge"],
    ["the verb from a backquote substitution", "gh pr `echo merge` 1"],
    ["a case-unsure verb, which bash 5 may upper-case", "declare -u V; V=merge; gh pr $V"],
    ["a known value bash splits into the group and verb", 'X="pr merge"; gh $X 1'],
    ["the same value quoted, which no gh group matches", 'X="pr merge"; gh "$X" 1'],
    ["a known repo value bash splits into the path", 'R="o/r pr merge"; gh -R $R 1'],
    ["a verb after a long flag the group level reads as taking a value", "gh pr --body x $V 1"],
    ["a verb after a short flag the group level reads as taking a value", "gh pr -b x $V 1"],
    ["a group after a flag the root reads as taking a value", "gh --body x $G merge 1"],
    ["a verb after a flag whose value would be unknown", 'gh pr --body "$B" merge 1'],
    ["a group after a cluster ending in R, which cobra reads as one word", 'gh -bR "$V" merge 1'],
    ["a verb after a cluster ending in R", 'gh pr -bR "$V" 1'],
    ["a verb after an empty word, which cobra drops", "gh pr '' \"$V\""],
    ["a group after a lone dash, which cobra drops", 'gh - "$X" create f'],
    ["a group after an empty word, which cobra drops", "gh '' \"$X\" merge 1"],
    ["a group after an empty double-quoted word", 'gh "" "$G"'],
  ])("is unknown for %s: %s", (_, line) => {
    expect(ghPathUnknown(ghArgs(line))).toBe(true);
  });
});

describe("a gh command path known as written", () => {
  it.each([
    ["a literal path", "gh pr view 1"],
    ["a variable past the verb", "gh pr view $N"],
    ["a quoted repo value", 'gh -R "$R" pr view 1'],
    ["a quoted attached repo value", 'gh --repo="$R" pr view 1'],
    ["an attached short repo value", 'gh -R"$R" pr view 1'],
    ["a variable after a group with no guarded verb", "gh run $X"],
    ["a run id", "gh run view $ID"],
    ["an api endpoint from a variable", "gh api $X"],
    ["an api endpoint with a variable", "gh api repos/$R/pulls"],
    ["a workflow target, not its verb", 'gh workflow run "$W"'],
    ["a flag value past the verb", 'gh pr create --title "$T"'],
    ["a literal merge", "gh pr merge 12 --squash"],
    ["a literal release", "gh release create v1"],
    ["a literal gist", "gh gist create f"],
    ["a literal option before the group", "gh --help pr view"],
    ["a help flag before a variable past the verb", "gh pr -h view $N"],
    ["a flag either reading leaves a known path after", "gh pr --body x view 1"],
    ["a no-value flag with a known path either way", "gh pr --web view 1"],
    ["an attached long value", "gh pr --body=x view 1"],
    ["a short cluster with a known path either way", "gh pr -bx view 1"],
    ["a repo option before the group", "gh -R o/r pr view 1"],
    ["a list", "gh pr list"],
    ["checks on a variable", "gh pr checks $N"],
    ["a run list", "gh run list -L 5"],
    ["an empty word with a known path either way", "gh pr '' view 1"],
    ["sixty flags, whose readings are memoised", `gh ${"-a ".repeat(60)}pr view 1`],
  ])("is known for %s: %s", (_, line) => {
    expect(ghPathUnknown(ghArgs(line))).toBe(false);
  });
});
