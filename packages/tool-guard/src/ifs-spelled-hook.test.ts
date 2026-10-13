import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { namesIfs } from "./shell/ifs.js";

const HOME = "/home/you";

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat/x", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

// The walk emits a function or loop body before the later write, as `git push origin,HEAD:main`, so only a
// line-wide namesIfs can tell it to keep `$R` raw. TP-2723 b wires that; these rows flip to `it` there.
const LATE_ESCAPED_IFS = [
  ["a function called after the write", "R=origin,HEAD:main; f(){ git push $R; }; declare I\\FS=,; f"],
  ["a loop whose later iteration writes", "R=origin,HEAD:main; for i in 1 2; do git push $R; declare I\\FS=,; done"],
  ["a loop inside bash -c", "bash -c 'R=origin,HEAD:main; for i in 1 2; do git push $R; declare I\\FS=,; done'"],
  ["a function called after a write whose name is joined", "R=origin,HEAD:main; f(){ git push $R; }; c=S; b=F; a=I; declare $a$b$c=,; f"],
] as const;

describe("an IFS write that runs after the push is spelled or built (TP-2723)", () => {
  it.each(LATE_ESCAPED_IFS)("is seen by namesIfs in %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.fails.each(LATE_ESCAPED_IFS)("denies %s through handle()", async (_form, line) => {
    expect(await handled(line)).toBe("deny");
  });

  it("passes the same push on a line without IFS", async () => {
    expect(await handled("R=origin; f(){ git push $R; }; f")).toBe("pass");
  });
});
