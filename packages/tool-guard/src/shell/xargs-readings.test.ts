import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { extractCommands } from "./commands.js";
import { MAX_ADDED_RUNS } from "./xargs-readings.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date(0), loadDecide: async () => decide };

async function decision(command: string): Promise<string> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  return stdout === "" ? "allow" : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

describe("an added xargs reading whose script cannot parse", () => {
  it.each([
    ["a quote", `git push origin HEAD:main; echo "'" | xargs -J % sh -c %`],
    ["an open substitution", "git push origin HEAD:main; echo '$(' | xargs -J % sh -c %"],
    ["a backtick", "git push origin HEAD:main; echo '`' | xargs -J % sh -c %"],
  ])("is dropped, so the hook still denies the push beside %s", async (_how, command) => {
    expect(await decision(command)).toBe("deny");
  });
});

describe("added xargs readings on a long input", () => {
  const words = Array.from({ length: 120 }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26))).join(" ");

  it.each([
    ["-I -i -J %", `git push origin HEAD:main; printf '${words}' | xargs -I -i -J % -d "$D" -n "$N" git %`],
    ["-I{} -J %", `git push origin HEAD:main; printf '${words}' | xargs -I{} -J % -d "$D" -n "$N" git %`],
  ])("stay under the cap and the hook timeout under %s", async (_how, command) => {
    const start = performance.now();
    const commands = extractCommands(command, { cwd: REPO, home: HOME });
    const verdict = await decision(command);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(commands.length).toBeLessThan(400 + MAX_ADDED_RUNS);
    expect(verdict).toBe("deny");
  });

  it("fails closed past the cap with the worst case at the insert argument", () => {
    const many = Array.from({ length: MAX_ADDED_RUNS + 1 }, (_, i) => `log${i}`).join(" ");
    const commands = extractCommands(`printf '${many}' | xargs -n 1 -J % git %`, { cwd: REPO, home: HOME });
    expect(commands.map((c) => c.args.map((a) => a.value).join(" "))).toContain("push origin HEAD:main");
  });
});
