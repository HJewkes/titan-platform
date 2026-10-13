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
    ["a single-quoted delimiter", ["\tcat <<'EOF'", "}", "EOF"]],
    ["a double-quoted delimiter", ['\tcat <<"EOF"', "}", "EOF"]],
    ["a backslash-quoted delimiter", ["\tcat <<\\EOF", "}", "EOF"]],
    ["a plain delimiter of word chars, dot and dash", ["\tcat <<E_1.x-y", "}", "E_1.x-y"]],
    ["two heredocs on one line", ["\tcat <<A <<\"B\"", "a", "A", "b", "B"]],
    ["a here-string", ["\tcat <<< x"]],
    ["a closed multi-line substitution", ["\tx=$(echo a", "}", ")"]],
    ["nested braces in a parameter", ['\tx=${y:-{a}}']],
    ["a shift inside $(( ))", ["\tx=$(( 1 << 2 ))"]],
    ["zsh glob flags", ["\t[[ $w == (#b)(((http|ftp)(|s))://*) ]]"]],
    ["a shift inside (( ))", ["\t(( y = x << n ))", "\tif (( a << 1 )) && (( b <<2 ))"]],
    ["plain (( )) and $(( )) arithmetic", ["\t(( y = x + 1 ))", "\tz=$(( y * 2 ))"]],
    ["a shift inside (( )) in a (pat) case arm", ["\t\t(a) (( y = x << n )) ;;"]],
    ["a shift inside (( )) in a pat) case arm", ["\t\ta) (( y = x << n )) ;;"]],
    ["a heredoc in a case arm", ["\t\t(a) cat << n ;;", "}", "n"]],
    ["a zsh case pattern opening with (( and no heredoc", ["\t\t((add-|)fpath) shift ;;"]],
    ["a comment holding a quote inside $( )", ["\tx=$(: # it's", ")"]],
    ["a heredoc read inside a multi-line $( )", ["\tx=$(cat <<EOF", "}", "EOF", ")"]],
    ["plain backticks", ["\tx=`basename $0`"]],
    ["a process substitution holding a quote and a )", ["\tdiff <(echo ')') >(cat) =(echo \")\")"]],
    ["parameter flags", ["\tx=${(j:,:)arr} y=${(s./.)p}"]],
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
    ["a (( that proves not to be arithmetic on a later line", ["\t((cat", ") )"]],
    ["a heredoc opened inside a (( read again as code", ["\t((cat <<EOF) )"]],
  ])("is not at top level inside %s", (_name, lines) => {
    expect(topLevelAfter(...lines)).toBe(false);
  });

  it.each([
    ["a heredoc in a $( ) closed on its line", ["\tx=$(cat <<EOF)", "EOF"]],
    ["a heredoc in a process substitution closed on its line", ["\tdiff <(cat <<EOF) x", "EOF"]],
    ["a heredoc whose line ends inside a later $( )", ["\tcat <<EOF; x=$(", "echo", ")", "body", "EOF"]],
    ["a heredoc in backticks", ["\tx=`cat <<EOF`", "EOF"]],
    ["a quote in backticks", ["\tx=`: # it's`"]],
    ["an escaped backtick in backticks", ["\tx=`echo \\`date\\``"]],
    ["a bare case pattern in a $( )", ["\tx=$(case $y in a) echo ;; esac)"]],
    ["a (# inside a $( )", ["\tx=$(print -l (#i)*.zsh)"]],
    ["$[ ] arithmetic", ["\tx=$[ 1 << 2 ]"]],
    ["a $'' delimiter, whose end line zsh spells without the $", ["\tcat <<$'EOF'", "EOF"]],
    ["a delimiter holding a parameter in double quotes", ['\tcat <<"E$X"']],
    ["a delimiter in backticks", ["\tcat <<`E`"]],
    ["a delimiter ending in an escaped $", ["\tcat <<E\\$"]],
    ["a quoted delimiter with spaces", ["\tcat <<'gp () {'", "}", "gp () {"]],
    ["a ' inside (( )), which zsh reads as a literal", ["\t(( y = 1 ' 2 ))"]],
    ['a " inside (( ))', ['\t(( y = "1" ))']],
    ["a backtick inside (( ))", ["\t(( y = `x` ))"]],
    ["a $' inside (( ))", ["\t(( y = $'1' ))"]],
    ["a ' inside $(( ))", ["\tx=$(( 1 ' 2 ))"]],
    ['a " inside $(( ))', ['\tx=$(( "1" ))']],
    ["a backtick inside $(( ))", ["\tx=$(( `y` ))"]],
    ["a << after a (( read as code: a zsh case pattern", ["\t\t((add-|)fpath) cat <<EOF ;;", "}", "EOF"]],
    ["a << after a (( read as code: a zsh glob in [[ ]]", ["\t[[ $x = ((#i)http|ftp)* ]] && cat <<EOF", "}", "EOF"]],
    ["a << after a (( read as code: nested subshells", ["\tx=$(", "((cat <<EOF) )", "}", "EOF", ")"]],
  ])("fails closed on %s", (_name, lines) => {
    const scan = newBodyScan();
    for (const line of lines) scanLine(scan, line);

    expect(scan.broken).toBe(true);
  });

  it("starts a heredoc only after a line continuation ends", () => {
    const scan = newBodyScan();
    scanLine(scan, "\tcat <<EOF \\");
    scanLine(scan, "\t| cat");

    expect(scan.reading).toEqual([{ delimiter: "EOF", stripTabs: false, owner: 0 }]);
  });
});
