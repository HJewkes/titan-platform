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
  ])("passes %s", (_, command) => {
    expect(verdict(command)).toBe("pass");
  });
});
