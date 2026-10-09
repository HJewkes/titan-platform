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
    ["a plain append", "P=1; P+=2; (( P ))"],
    ["a plain compound array and element write", "arr=(1 2 3); a[1]=5; arr+=(4); (( arr[1] ))"],
    ["an append of plain text to a value from input", "read P; P+=' more'"],
  ])("passes %s", (_, command) => {
    expect(verdict(command)).toBe("pass");
  });
});
