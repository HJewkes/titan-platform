import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const home = mkdtempSync(join(tmpdir(), "tool-guard-arith-paren-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

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

// zsh reads `$(( … ))` as `$( ( … ) )` when a quote in the body holds a paren, so it runs the body as a command.
describe("a quoted paren in $(( ))", () => {
  it.each([
    ["a single-quoted close paren", "echo $(( git push origin HEAD:main ')' ))"],
    ["a double-quoted open paren", `echo $(( git push origin HEAD:main "(" ))`],
    ["an ANSI-C close paren", "echo $(( git push origin HEAD:main $')' ))"],
    ["inside double quotes", `echo "$(( git push origin HEAD:main ')' ))"`],
    ["an assignment value", "x=$(( git push origin HEAD:main ')' ))"],
  ])("denies %s", async (_name, command) => {
    expect(await handled(command)).toBe("deny");
  });

  it.each([["plain arithmetic", "echo $(( 1 + 2 ))"], ["a subscript", "echo $(( a[1] ))"], ["double-quoted arithmetic", `echo "$(( x ))"`]])(
    "passes %s",
    async (_name, command) => {
      expect(await handled(command)).toBe("pass");
    },
  );

  it("stays cheap when quoted-paren arithmetic nests deeply", async () => {
    let body = "x";
    for (let i = 0; i < 24; i++) body = `$(( '(' ${body} ))`;
    const started = Date.now();
    await handled(`echo ${body}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
