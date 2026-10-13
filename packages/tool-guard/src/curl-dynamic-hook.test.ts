import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const noFiles: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFiles), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function logColumns(command: string): Promise<{ stdout: string; columns: string[] | undefined }> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
  const result = await handle(input, {}, port);
  return { stdout: result.stdout, columns: result.log[0]?.split("\t").slice(1, 6) };
}

describe("handle: an HTTP write to a run-time URL", () => {
  it.each([
    'curl -X PUT "$URL"',
    "curl -XPUT $U",
    'curl --request PUT "$U"',
    'wget --method=PUT "$U"',
    'http PUT "$U"',
    'curl -X "$M" "$U"',
    'curl -X PUT "https://api.github.com/repos/$R/pulls/1/merge"',
  ])("denies %s as a merge", async (command) => {
    const { columns } = await logColumns(command);

    expect(columns).toEqual(["deny", "MRG-WK", "merge", "bash.merge.curl-api", "coordinator+worker+headless"]);
  });

  it("keeps a literal non-GitHub upload under egress", async () => {
    const { columns } = await logColumns("curl -X PUT https://example.com/x");

    expect(columns).toEqual(["deny", "EXT-CO", "private-egress", "bash.egress.curl-upload", "coordinator+worker+headless"]);
  });

  it("lets a GET to a run-time URL through", async () => {
    const { stdout } = await logColumns('curl -X GET "$U"');

    expect(stdout).toBe("");
  });
});
