import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

// Through handle() and through the built hook, as a harness runs it. CI builds before it tests; locally run `pnpm build` first.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-store-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PUSH = "git push origin HEAD:main";
const PAYLOAD = `'a[$(${PUSH})]'`;

const port: HookPort = {
  context: nodeContext(home, { realpath: (p) => p, readHead: () => { throw new Error("ENOENT"); }, isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

function built(command: string): "deny" | "pass" {
  const run = spawnSync(process.execPath, [bin, "hook"], { input: input(command), env: { ...process.env, HOME: home }, encoding: "utf-8" });
  expect(run.status).toBe(0);
  return run.stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

describe("a typed payload stored without an assignment word, then read as arithmetic (TP-1624)", () => {
  it.each([
    ["a here-string read", `read X <<< ${PAYLOAD}; (( X ))`],
    ["a quoted heredoc read", `read X <<'EOT'\na[$(${PUSH})]\nEOT\n(( X ))`],
    ["a here-string mapfile", `mapfile -t A <<< ${PAYLOAD}; (( A[0] ))`],
    ["set --", `set -- ${PAYLOAD}; (( $1 ))`],
    ["a function argument", `f() { (( $1 )); }; f ${PAYLOAD}`],
    ["a function argument copied to a local", `f() { local n=$1; (( n )); }; f ${PAYLOAD}`],
    ["a bash -c positional parameter", `bash -c '(( $1 ))' _ ${PAYLOAD}`],
    ["a value exported to a child shell", `export X=${PAYLOAD}; bash -c '(( X ))'`],
    ["a here-string read inside a loop", `while read X; do (( X )); done <<< ${PAYLOAD}`],
    ["a piped read in a group", `echo ${PAYLOAD} | { read X; (( X )); }`],
  ])("denies %s", async (_, command) => {
    expect(await handled(command)).toBe("deny");
    expect(built(command)).toBe("deny");
  });
});

describe("a payload a name operand or a positional offset reads as arithmetic (TP-1624)", () => {
  const value = `X=${PAYLOAD}`;
  it.each([
    ["a printf -v target with a subscript", `${value}; printf -v 'b[X]' 1`],
    ["an attached printf -v target with a subscript", `${value}; printf -vb[X] 1`],
    ["a read target with a subscript", `${value}; read 'b[X]' <<< 1`],
    ["a read target named by a variable", `${value}; N='b[X]'; read "$N" <<< 1`],
    ["a positional parameter offset", `${value}; set -- 1 2; echo \${1:X}`],
    ["an offset into all positional parameters", `${value}; set -- 1 2; echo "\${@:X}"`],
    ["an offset into the joined positional parameters", `${value}; set -- 1 2; echo "\${*:X}"`],
  ])("denies %s", async (_, command) => {
    expect(await handled(command)).toBe("deny");
    expect(built(command)).toBe("deny");
  });
});

describe("set stores positional parameters only through its operands (TP-1624)", () => {
  const body = "gh pr create --title t --body \"$(cat <<'EOF'\n- [x] ran `pnpm test`\nEOF\n)\"";

  it("passes shell options set beside arithmetic and a PR body", async () => {
    const command = `set -euo pipefail; n=3; (( n>0 )); ${body}`;
    expect(await handled(command)).toBe("pass");
    expect(built(command)).toBe("pass");
  });

  it.each([
    ["set -- with an expansion", `set -- "$X"; (( n>0 )); ${body}`],
    ["set with operands and no --", `set -e "$X"; (( n>0 )); ${body}`],
  ])("still denies %s", async (_, command) => {
    expect(await handled(command)).toBe("deny");
    expect(built(command)).toBe("deny");
  });
});

describe("a value nothing on the line reads as arithmetic (TP-1624)", () => {
  it.each([
    ["a PR body with a checklist and inline code", "BODY=$(cat <<'EOF'\n- [x] tests pass\n- Run `pnpm test` locally\nEOF\n); gh pr create --title t --body \"$BODY\""],
    ["a message with an odd number of backquotes after a bracket", "msg='Fix [TP-1]: use `it'\"'\"'s` form'"],
    ["a regex bracket", "re='[$(]'; grep -E \"$re\" f"],
    ["prose that names a push", "body='See [docs](x). Do not run `git push origin HEAD:main` by hand.'"],
  ])("passes %s", async (_, command) => {
    expect(await handled(command)).toBe("pass");
    expect(built(command)).toBe("pass");
  });
});
