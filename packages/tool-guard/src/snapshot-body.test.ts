import { describe, expect, it } from "vitest";
import { atTopLevel, newBodyScan, scanLine } from "./snapshot-body.js";

function topLevelAfter(...lines: string[]): boolean {
  const scan = newBodyScan();
  for (const line of lines) scanLine(scan, line);
  return atTopLevel(scan);
}

describe("snapshot body scan", () => {
  it.each([
    ["plain code", ["\tgit push", '\techo "a" \'b\' $\'c\\\'\'']],
    ["a closed heredoc", ["\tcat <<EOF", "}", "EOF"]],
    ["a <<- heredoc ended by a tab-indented line", ["\tcat <<-EOF", "}", "\t\tEOF"]],
    ["a quoted delimiter with spaces", ["\tcat <<'gp () {'", "}", "gp () {"]],
    ["two heredocs on one line", ["\tcat <<A <<\"B\"", "a", "A", "b", "B"]],
    ["a here-string", ["\tcat <<< x"]],
    ["a closed multi-line substitution", ["\tx=$(echo a", "}", ")"]],
    ["nested braces in a parameter", ['\tx=${y:-{a}}']],
    ["a shift inside $(( ))", ["\tx=$(( 1 << 2 ))"]],
    ["zsh glob flags", ["\t[[ $w == (#b)(((http|ftp)(|s))://*) ]]"]],
    ["a shift inside (( ))", ["\t(( y = x << n ))", "\tif (( a << 1 )) && (( b <<2 ))"]],
    ["a zsh case pattern opening with ((", ["\t\t((add-|)fpath) cat <<EOF ;;", "}", "EOF"]],
    ["a zsh glob opening with (( inside [[ ]]", ["\t[[ $x = ((#i)http|ftp)* ]] && cat <<EOF", "}", "EOF"]],
    ["a comment holding a quote inside $( )", ["\tx=$(: # it's", ")"]],
    ["a comment holding a quote inside backticks", ["\tx=`: # it's", "`"]],
  ])("is at top level after %s", (_name, lines) => {
    expect(topLevelAfter(...lines)).toBe(true);
  });

  it.each([
    ["an open heredoc", ["\tcat <<EOF"]],
    ["an open double quote", ['\techo "x']],
    ["an open single quote", ["\techo 'x"]],
    ["an open $'", ["\techo $'x"]],
    ["an open substitution", ["\tx=$(echo"]],
    ["an open backtick", ["\tx=`echo"]],
    ["an open parameter", ["\tx=${y:-"]],
    ["a heredoc with no delimiter", ["\tcat <<"]],
    ["a delimiter with an open quote", ["\tcat <<'EOF"]],
  ])("is not at top level inside %s", (_name, lines) => {
    expect(topLevelAfter(...lines)).toBe(false);
  });

  it("starts a heredoc only after a line continuation ends", () => {
    const scan = newBodyScan();
    scanLine(scan, "\tcat <<EOF \\");
    scanLine(scan, "\t| cat");

    expect(scan.reading).toEqual([{ delimiter: "EOF", stripTabs: false }]);
  });
});
