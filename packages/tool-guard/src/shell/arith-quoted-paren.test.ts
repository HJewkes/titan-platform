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
    ["a backquote holding a case arm", "echo $(( git push origin HEAD:main `case a in a) ;; esac` ))"],
    ["a backquote holding a quoted paren", "echo $(( git push origin HEAD:main `echo ')'` ))"],
    ["a backquote in an assignment", "x=$(( git push origin HEAD:main `case a in a) ;; esac` ))"],
    ["a backquote inside double quotes", 'echo "$(( git push origin HEAD:main `case a in a) ;; esac` ))"'],
    ["a locale string holding a paren", 'echo $(( git push origin HEAD:main $"(" ))'],
    ["a heredoc body", "cat <<EOF\n$(( git push origin HEAD:main `case a in a) ;; esac` ))\nEOF"],
    ["a comment holding a paren", "echo $(( git push origin HEAD:main #)\n ))"],
    ["a lone close paren across a newline", "echo $(( git push origin HEAD:main )\n( ))"],
  ])("denies %s", async (_name, command) => {
    expect(await handled(command.replaceAll("\\n", "\n"))).toBe("deny");
  });

  it.each([["plain arithmetic", "echo $(( 1 + 2 ))"], ["a subscript", "echo $(( a[1] ))"], ["double-quoted arithmetic", `echo "$(( x ))"`], ["arithmetic across a newline", "echo $(( 1 +\\n 2 ))"], ["a variable", "echo $(( $a + 1 ))"]])(
    "passes %s",
    async (_name, command) => {
      expect(await handled(command.replaceAll("\\n", "\n"))).toBe("pass");
    },
  );

  it.each([[8, 1000], [24, 100]])("stays cheap when quoted-paren arithmetic nests %i deep around a body of %i terms", async (depth, terms) => {
    let body = `x${" + 1".repeat(terms)}`;
    for (let i = 0; i < depth; i++) body = `$(( '(' ${body} ))`;
    const started = Date.now();
    await handled(`echo ${body}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
