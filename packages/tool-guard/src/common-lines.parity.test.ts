import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COMMON_LINES, COMMON_LINE_FIXTURES, REFUSED_COMMON_LINES } from "./common-lines.js";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const home = realpathSync.native(
  mkdtempSync(join(tmpdir(), "tool-guard-common-"))
);
const cwd = join(home, "app");
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const [path, { text, mode }] of Object.entries(COMMON_LINE_FIXTURES)) {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text, { mode });
  chmodSync(join(home, path), mode);
}

const port: HookPort = {
  context: nodeContext(home),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

// B25 (`for f in *`) is not a row: it denies as SEC-CO in every cwd. A crash in handle() also prints nothing, so a row
// asserts the whole result (no log line), not just empty stdout.
describe("common-line parity corpus", () => {
  it("has unique row ids", () => {
    const ids = [...COMMON_LINES, ...REFUSED_COMMON_LINES].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(COMMON_LINES.map((row) => [row.family, row.line, row.id] as const))(
    "main allows %s: %s (%s)",
    async (_family, line) => {
      expect(await handle(event(line), {}, port)).toEqual({ stdout: "", log: [] });
    }
  );

  it.each(REFUSED_COMMON_LINES.map((row) => [row.family, row.line, row.id, row.why] as const))(
    "refuses %s: %s (%s), for %s",
    async (_family, line) => {
      const { stdout } = await handle(event(line), {}, port);
      expect(stdout).toMatch(/does not follow a command name the line rebinds/);
    }
  );
});

function event(line: string): string {
  return JSON.stringify({
    tool_name: "Bash",
    session_id: "s",
    tool_use_id: "t",
    cwd,
    tool_input: { command: line },
  });
}
