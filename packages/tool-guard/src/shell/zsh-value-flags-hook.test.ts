import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";

const HOME = "/home/you";
const PUSH = "git push origin HEAD:feat";

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

const REFUSED = [
  ["a braced tilde flag", "echo ${~x}"],
  ["a doubled braced tilde flag", "echo ${~~x}"],
  ["a bare tilde expansion", "echo $~x"],
  ["an equals-tilde flag", "echo ${=~x}"],
  ["an e flag", "echo ${(e)x}"],
  ["an e flag after another", "echo ${(Le)x}"],
  ["an e flag in double quotes", 'echo "${(e)x}"'],
  ["a tilde nested in a default", "echo ${y:-${~x}}"],
  ["an e flag in arithmetic", "echo $(( ${(e)x} ))"],
  ["an e flag in an unquoted heredoc body", "cat <<E\n${(e)x}\nE"],
] as const;

const PASSED = [
  ["plain expansions and harmless flags", "echo ${x} ${#x} ${(L)x} ${(j:,:)x} ${(s:e:)x}"],
  ["a single-quoted tilde expansion", "echo '${~x}'"],
  ["a quoted heredoc body", "cat <<'E'\n${(e)x}\nE"],
  ["a dollar field in awk", "awk '{print $~1}'"],
] as const;

describe("zsh expansions that run their value are refused by the lexer (TP-2937)", () => {
  it.each(REFUSED)("throws ParseError for %s", (_form, line) => {
    expect(() => tokenize(`${line}; ${PUSH}`)).toThrow(ParseError);
  });

  it.each(REFUSED)("denies %s through handle()", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("deny");
  });

  it.each(PASSED)("allows %s", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("pass");
  });

  it("allows the push alone", async () => {
    expect(await handled(PUSH)).toBe("pass");
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zsh)("zsh really runs the value of the refused forms (TP-2937)", () => {
  function runs(body: string, assign: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zsh-value-"));
    try {
      fs.writeFileSync(path.join(dir, "f"), "");
      spawnSync("zsh", ["-f", "-c", `${assign}; ${body}`], { cwd: dir, stdio: "ignore" });
      return fs.existsSync(path.join(dir, "m"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const QUALIFIER = 'x="*(e:touch m:)"';

  it("runs a glob qualifier through ${~x}", () => {
    expect(runs("print -r -- ${~x} >/dev/null", QUALIFIER)).toBe(true);
  });

  it("runs a glob qualifier through $~x", () => {
    expect(runs("print -r -- $~x >/dev/null", QUALIFIER)).toBe(true);
  });

  it("runs a command substitution through ${(e)y}", () => {
    expect(runs("print -r -- ${(e)y} >/dev/null", `y='$(touch m)'`)).toBe(true);
  });

  it("runs nothing through ${~~x}, so its refusal is an over-approximation", () => {
    expect(runs("print -r -- ${~~x} >/dev/null", QUALIFIER)).toBe(false);
  });

  it("runs nothing through a quoted ${~x}, so its refusal is an over-approximation", () => {
    expect(runs('print -r -- "${~x}" >/dev/null', QUALIFIER)).toBe(false);
  });
});
