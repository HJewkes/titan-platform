import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Through the built hook, as a harness runs it. CI builds before it tests; locally run `pnpm build` first.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-arith-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PUSH = "git push origin HEAD:main";
const HIDDEN = `X='a[$(${PUSH})]'`;

function verdict(command: string): "deny" | "pass" {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const run = spawnSync(process.execPath, [bin, "hook"], { input, env: { ...process.env, HOME: home }, encoding: "utf-8" });
  expect(run.status).toBe(0);
  return run.stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

describe("a subscript in a variable's value that holds code, whichever way the variable is read (TP-1624)", () => {
  it.each([
    ["an integer variable assigned later", `${HIDDEN}; declare -i n=0; n=X`],
    ["an integer variable appended later", `${HIDDEN}; declare -i n; n+=X`],
    ["a subscript in a compound array assignment", `${HIDDEN}; a=([X]=1)`],
    ["a subscript in an appended compound array assignment", `${HIDDEN}; a+=([X]=1)`],
    ["arithmetic in an unquoted heredoc body", `${HIDDEN}; cat <<EOT\n$(( X ))\nEOT`],
    ["a nameref", `${HIDDEN}; declare -n R=X; (( R ))`],
    ["an indirect expansion", `${HIDDEN}; Y=X; echo "\${!Y}"`],
    ["printf -v", `${HIDDEN}; printf -v n '%s' "$X"; (( n ))`],
    ["unset", `${HIDDEN}; unset X`],
    ["test -v", `${HIDDEN}; [[ -v X ]]`],
    ["a declared value", `declare ${HIDDEN}; (( X ))`],
    ["a prefix assignment", `${HIDDEN} true`],
    ["a plain (( ))", `${HIDDEN}; (( X ))`],
    ["an append that completes the subscript, read as an integer", `X='a['; X+='$(${PUSH})]'; declare -i n=0; n=X`],
    ["an append that completes the subscript, used as a key", `X='a['; X+='$(${PUSH})]'; a=([X]=1)`],
    ["a compound array element", `arr=('a[$(${PUSH})]'); (( arr[0] ))`],
    ["a compound array element read as an integer", `arr=('a[$(${PUSH})]'); declare -i n=0; n=\${arr[0]}`],
    ["a later compound array element", `arr=(1 'a[$(${PUSH})]'); (( arr[1] ))`],
    ["an element write", `a[1]='b[$(${PUSH})]'; declare -i n=0; n=\${a[1]}`],
    ["an element append", `a[1]=x; a[1]+='b[$(${PUSH})]'; declare -i n=0; n=\${a[1]}`],
    ["an appended compound array", `arr=(1); arr+=('a[$(${PUSH})]'); (( arr[1] ))`],
    ["an append to a value read from input", `read P; P+='x [$(${PUSH})]'`],
    ["a literal payload with a command substitution after it", `X="a[\\$(${PUSH})]$(true)"; (( X ))`],
    ["a literal payload with a command substitution before it", `X="$(true)a[\\$(${PUSH})]"; let X`],
    ["a literal payload with a variable after it", `X="a[\\$(${PUSH})]$RANDOM"; (( X ))`],
    ["a partly known value read by $(( ))", `X="a[\\$(${PUSH})]$RANDOM"; echo $(( X ))`],
    ["a partly known value read by [[ -eq ]]", `X="a[\\$(${PUSH})]$RANDOM"; [[ X -eq 0 ]]`],
    ["a partly known local", `f() { local X="a[\\$(${PUSH})]$RANDOM"; (( X )); }; f`],
    ["a partly known declare", `declare X="a[\\$(${PUSH})]$RANDOM"; (( X ))`],
    ["a default expansion value", `X=\${Q:-a[\\$(${PUSH})]}; (( X ))`],
    ["a quoted default expansion value", `X="\${Q:-a[\\$(${PUSH})]}"; (( X ))`],
    ["an assigning default expansion", `echo \${Q:=a[\\$(${PUSH})]}; (( Q ))`],
    ["a for loop list", `for X in 'a[$(${PUSH})]'; do (( X )); done`],
    ["a select list", `select X in 'a[$(${PUSH})]'; do (( X )); break; done`],
    ["a value built from the loop counter", `for ((i=0;i<1;i++)); do X="a[\\$(${PUSH})]$i"; (( X )); done`],
    ["the output of a command that types the payload", `X=$(echo 'a[$(${PUSH})]'); (( X ))`],
    ["the output of a heredoc that types the payload", `X=$(cat <<'EOT'\na[$(${PUSH})]\nEOT\n); (( X ))`],
    ["an array element that is partly known", `arr=("a[\\$(${PUSH})]$RANDOM"); (( arr[0] ))`],
    ["an append of a partly known part", `X='a['; X+="$(true)\\$(${PUSH})]"; (( X ))`],
    ["an append to a declared value", `declare X='a['; declare X+='$(${PUSH})]'; (( X ))`],
  ])("denies a push behind %s", (_, command) => {
    expect(verdict(command)).toBe("deny");
  });
});

describe("benign arithmetic and values stay unchecked (TP-1624)", () => {
  it.each([
    ["a quote-bearing value in a [[ -n ]]", `msg="don't publish"; [[ -n $msg ]]`],
    ["an arithmetic for over a counter", "n=3; for ((i=0; i<n; i++)); do :; done"],
    ["a numeric [[ ]] on a count", "count=5; [[ $count -gt 10 ]]"],
    ["a substring offset", "s=hello; echo ${s:1}"],
    ["git log with a numeric-looking word", "git log --oneline -n 3 -eq"],
    ["a value with a plain subscript", "X='a[1]'; (( X ))"],
    ["a log prefix with the date", `msg="[$(date)] done"; echo "$msg"`],
    ["a value from a command with a counter", `i=3; n=$(wc -l < /dev/null); X="x$i"; (( n > 0 )); (( X ))`],
    ["a subscript that reads a variable", `i=1; X="a[$i]"; (( X ))`],
    ["a default with no code", "X=${Q:-5}; (( X )); echo ${R:=3}"],
    ["a for loop over words", "for f in a b c; do echo $f; done"],
    ["a plain append", "P=1; P+=2; (( P ))"],
    ["a plain compound array and element write", "arr=(1 2 3); a[1]=5; arr+=(4); (( arr[1] ))"],
    ["an append of plain text to a value from input", "read P; P+=' more'"],
  ])("passes %s", (_, command) => {
    expect(verdict(command)).toBe("pass");
  });
});
