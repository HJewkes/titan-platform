import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { extractCommands } from "./commands.js";

const home = mkdtempSync(join(tmpdir(), "tool-guard-subscript-quote-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PUSH = "git push origin HEAD:main";

const port: HookPort = {
  context: nodeContext(home, { realpath: (p) => p, readHead: () => { throw new Error("ENOENT"); }, isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

async function handled(command: string): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "pass" : "deny";
}

const names = (src: string): string[] => extractCommands(src).map((c) => [c.name, ...c.args.map((a) => a.value)].join(" "));

// A subscript on an assignment word and the operands of [[ -eq ]] are arithmetic, so bash reads a single quote there like a double quote.
const HIDDEN: [string, string][] = [
  ["a single-quoted $( ) in an assignment subscript", `a['$(${PUSH})']=1`],
  ["a single-quoted $( ) in a spaced subscript", `x[ '$(${PUSH})' ]=1`],
  ["a single-quoted backtick in a subscript", `a['\`${PUSH}\`']=1`],
  ["a single-quoted backtick in a spaced subscript", `x[ '\`${PUSH}\`' ]=1`],
  ["a single-quoted $( ) in a += subscript", `a['$(${PUSH})']+=1`],
  ["a single-quoted $( ) in a subscript after a command", `true; a['$(${PUSH})']=1`],
  ["a single-quoted $( ) in an element of a compound assignment", `a=( ['$(${PUSH})']=1 )`],
  ["a single-quoted $( ) in an element after another", `a=( [0]=x ['$(${PUSH})']=1 )`],
];


// The value of a subscript or [[ -eq ]] operand is evaluated as arithmetic, so a $( or backtick left in it as text runs
// wherever the word stands and however the text was written.
const DENIED: [string, string][] = [
  ["a single-quoted $( ) in the right operand of -eq", `[[ 1 -eq 'a[$(${PUSH})]' ]]`],
  ["a single-quoted backtick in the right operand of -eq", `[[ 1 -eq 'a[\`${PUSH}\`]' ]]`],
  ["a single-quoted $( ) in the left operand of -eq", `[[ 'a[$(${PUSH})]' -eq 1 ]]`],
  ["a single-quoted $( ) in -ne", `[[ 1 -ne 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) in -lt", `[[ 1 -lt 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) in -le", `[[ 1 -le 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) in -gt", `[[ 1 -gt 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) in -ge", `[[ 1 -ge 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) in -eq after another test", `[[ -n x && 1 -eq 'a[$(${PUSH})]' ]]`],
  ["a single-quoted $( ) after an earlier [[ ]]", `[[ x ]] && a['$(${PUSH})']=1`],
  ["a single-quoted $( ) after an earlier (( ))", `(( 1 )); a['$(${PUSH})']=1`],
  ["a single-quoted $( ) after an earlier case", `case x in x) a['$(${PUSH})']=1;; esac`],
  ["a single-quoted $( ) after an earlier if [[ ]]", `if [[ x ]]; then a['$(${PUSH})']=1; fi`],
  ["a single-quoted $( ) after a here-doc", `cat <<E\nx\nE\na['$(${PUSH})']=1`],
  ["a raw ]] inside the quoted operand", `[[ 'a[$(${PUSH}; echo "]]")]' -eq 1 ]]`],
  ["a double-quoted escaped $( ) in a subscript", `a["\\$(${PUSH})"]=1`],
  ["an escaped $( ) in a subscript", `a[\\$\\(${PUSH.replaceAll(" ", "\\ ")}\\)]=1`],
  ["an escaped $( ) in a nested subscript", `a[a[\\$\\(${PUSH.replaceAll(" ", "\\ ")}\\)]]=1`],
  ["a double-quoted escaped $( ) in an -eq operand", `[[ 1 -eq "a[\\$(${PUSH})]" ]]`],
  ["an escaped $( ) in an -eq operand", `[[ 1 -eq a[\\$\\(${PUSH.replaceAll(" ", "\\ ")}\\)] ]]`],
  ["a mixed real and quoted $( ) in a subscript", `a['$(${PUSH})'$(true)]=1`],
  ["a single-quoted $( ) in declare", `declare a['$(${PUSH})']=1`],
];

describe("a single-quoted command substitution in a subscript or [[ -eq ]] runs (TP-3353)", () => {
  it.each(HIDDEN)("denies %s", async (_, src) => {
    expect(await handled(src)).toBe("deny");
  });

  it.each(HIDDEN)("extracts git push from %s", (_, src) => {
    expect(names(src).some((n) => n.startsWith(PUSH))).toBe(true);
  });
});

describe("code text in an arithmetic value is denied wherever it stands (TP-3353)", () => {
  it.each(DENIED)("denies %s", async (_, src) => {
    expect(await handled(src)).toBe("deny");
  });
});

describe("single quotes elsewhere keep their reading (TP-3353)", () => {
  it.each([
    ["a literal key in a subscript", "a['k']=1"],
    ["a quoted word in a compound assignment", `a=( 'k' '$(${PUSH})' )`],
    ["a quoted substitution in a test command", `[ x = '$(${PUSH})' ]`],
    ["a quoted substitution as a let argument", `let '$(${PUSH})'`],
    ["a quoted operand of -eq without a substitution", "[[ 'a' -eq 1 ]]"],
    ["a plain -eq test", "[[ $x -eq 1 ]]"],
    ["a quoted substitution as an argument", `echo '$(${PUSH})'`],
    ["a quoted substitution in a string test", `[[ x == '$(${PUSH})' ]]`],
    ["a quoted substitution after a closed -eq test", `[[ 1 -eq 1 ]]; echo '$(${PUSH})'`],
    ["a quoted substitution after a closed subscript", `a[1]=2; echo '$(${PUSH})'`],
  ])("allows %s", async (_, src) => {
    expect(await handled(src)).toBe("pass");
    expect(names(src)).not.toContain(PUSH);
  });
});
