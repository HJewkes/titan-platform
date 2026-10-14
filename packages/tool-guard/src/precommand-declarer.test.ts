import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { tokenize } from "./shell/lexer.js";
import { nameOperandEvaluates } from "./shell/arith-words.js";
import type { WordToken } from "./shell/tokens.js";

// zsh's precommand modifiers noglob, nocorrect and - still run the builtin after them in the current shell (TP-2716).
const home = mkdtempSync(join(tmpdir(), "tool-guard-precommand-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

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

const words = (src: string): WordToken[] => tokenize(src).filter((t): t is WordToken => t.type === "word");

const MODIFIERS = ["noglob", "nocorrect", "-"];

describe("a name operand behind a zsh precommand modifier is read like one behind command", () => {
  it.each([
    ["noglob read with a subscript", "noglob read 'b[X]'"],
    ["nocorrect printf -v with a dynamic name", `nocorrect printf -v "$N" x`],
    ["- read with a dynamic name", `- read "$N"`],
    ["stacked modifiers before read", "nocorrect noglob read 'b[X]'"],
  ])("evaluates %s", (_, src) => {
    expect(nameOperandEvaluates(words(src))).toBe(true);
    expect(nameOperandEvaluates(words(src.replace(/^(nocorrect noglob|noglob|nocorrect|-) /, "command ")))).toBe(true);
  });
});

describe("a payload a name operand behind a zsh precommand modifier reads as arithmetic is denied (TP-1624)", () => {
  const value = "X='a[$(git push origin HEAD:main)]'";
  it.each([
    ...MODIFIERS.map((m) => [`${m} read with a subscript`, `${value}; ${m} read 'b[X]' <<< 1`]),
    ...MODIFIERS.map((m) => [`${m} printf -v with a subscript`, `${value}; ${m} printf -v 'b[X]' 1`]),
    ["stacked modifiers before read", `${value}; nocorrect noglob read 'b[X]' <<< 1`],
  ])("denies %s", async (_, command) => {
    expect(await handled(command)).toBe("deny");
  });
});

describe("a readonly behind a word that may run a program is not sure, so a later assignment still counts", () => {
  const after = "Y=push; git $Y origin HEAD:main";
  it.each([
    ["command -", `command - readonly Y=status; ${after}`],
    ["command -p -", `command -p - readonly Y=status; ${after}`],
    ["builtin -", `builtin - readonly Y=status; ${after}`],
    ["time -", `time - readonly Y=status; ${after}`],
    ["noglob", `noglob readonly Y=status; ${after}`],
    ["nocorrect", `nocorrect readonly Y=status; ${after}`],
    ["-", `- readonly Y=status; ${after}`],
    ["command noglob", `command noglob readonly Y=status; ${after}`],
    ["a quoted noglob", `'noglob' readonly Y=status; ${after}`],
  ])("denies %s readonly", async (_, command) => {
    expect(await handled(command)).toBe("deny");
  });
});
