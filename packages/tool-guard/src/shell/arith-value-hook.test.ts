import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const port: HookPort = {
  context: nodeContext(HOME, {
    realpath: (p) => p,
    readHead: () => {
      throw new Error("ENOENT");
    },
    isFile: () => false,
  }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "pass" : "deny";
}

describe("the hook verdict on a value that arithmetic reads (TP-1624)", () => {
  it("denies a push after a quote-bearing value named in a [[ ]]", async () => {
    expect(await verdict(`msg="don't"; [[ -n $msg ]] && ${PUSH}`)).toBe("deny");
  });

  it("denies a push after a quote-bearing value named in a (( )) and in a let", async () => {
    expect(await verdict(`msg="don't"; (( msg )); ${PUSH}`)).toBe("deny");
    expect(await verdict(`t='\`'; let t; ${PUSH}`)).toBe("deny");
  });

  it("passes a benign line whose value holds a quote", async () => {
    expect(await verdict(`msg="don't publish"; [[ -n $msg ]]`)).toBe("pass");
  });

  it("denies a push after a value that holds many substitutions read again and again", async () => {
    const value = `X='a[${"$(echo 1)".repeat(200)}]'`;
    const command = `${value}${";a[X]=1".repeat(800)}; ${PUSH}`;
    const started = performance.now();

    const result = await verdict(command);

    expect(result).toBe("deny");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
