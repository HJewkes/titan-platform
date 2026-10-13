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
    'http "$M" "$U"',
    'http put "$U"',
    'curl -X PUT "$U" --next -X GET https://example.com/x',
    'curl -X PUT "$U" -: -X GET https://example.com/x',
    'echo "$U" | xargs curl -X PUT',
    "wget --method=PUT -i urls",
    'curl --variable %P --expand-url "https://api.github.com/{{P}}" -X PUT',
    'curl -X PUT "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl -g --no-globoff -X PUT "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl -X PUT --expand-url "https://api.github.com/repos/o/r/pulls/1/merg{e}"',
    'curl --variable %M --expand-request "{{M}}" https://api.github.com/repos/o/r/pulls/1/merge',
    'curl --variable %M --expand-request "{{M}}" "$U"',
    "curl --expand-upload-file f https://api.github.com/repos/o/r/pulls/1/merge",
    "curl --request-target /repos/o/r/pulls/1/merge -X PUT https://api.github.com/x",
    "curl -K cfg -X PUT https://api.github.com/x",
    "curl --some-future-option -X PUT https://api.github.com/x",
    'curl -X PUT "$U" -s: -X GET https://example.com/x',
    'curl -X PUT "$U" -:s -X GET https://example.com/x',
    'curl -X PUT "$U" $N -X GET https://example.com/x',
    'curl -X PUT "$U" "$N" -X GET https://example.com/x',
    'curl "$OPT" PUT https://api.github.com/repos/o/r/pulls/1/merge',
    'curl "$D" --next https://api.github.com/repos/o/r/pulls/1/merge',
    'set -- -X PUT https://api.github.com/repos/o/r/pulls/1/merge; curl "$@"',
    'A=(-X PUT https://api.github.com/repos/o/r/pulls/1/merge); curl "${A[@]}"',
    'wget $A "$U"',
    'wget "$O" PUT "$U"',
    "wget $A https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -emethod=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -qe method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --execute=method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --execute method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e 'method = put' https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --meth=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --metho PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --post-d=x https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --body-d x --method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e post_data=x https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --config=rc https://api.github.com/repos/o/r/pulls/1/merge",
    "WGETRC=rc wget https://api.github.com/repos/o/r/pulls/1/merge",
    "wget -e robots=off https://api.github.com/repos/o/r/pulls/1/merge",
    "wget --some-future-option https://api.github.com/repos/o/r/pulls/1/merge",
    'wget -e "$E" https://api.github.com/repos/o/r/pulls/1/merge',
  ])("denies %s as a merge", async (command) => {
    const { columns } = await logColumns(command);

    expect(columns).toEqual(["deny", "MRG-WK", "merge", "bash.merge.curl-api", "coordinator+worker+headless"]);
  });

  it("keeps a literal non-GitHub upload under egress", async () => {
    const { columns } = await logColumns("curl -X PUT https://example.com/x");

    expect(columns).toEqual(["deny", "EXT-CO", "private-egress", "bash.egress.curl-upload", "coordinator+worker+headless"]);
  });

  it.each(["curl -X GET \"$U\"", "curl -fsSL --compressed https://api.github.com/repos/o/r/pulls/1", "curl -g --no-get --globoff https://api.github.com/repos/o/r", "curl --no-progress-meter -sS https://example.com/x", 'curl --include "$U"', 'curl --progress-meter -s "$U"', 'curl -s: -I "$U"', 'curl -s "https://api.github.com/repos/$R/pulls" -H "Authorization: Bearer $T"', 'curl -s "http://localhost:8080/$P" -o f', "wget -q -nv --no-config -O out https://api.github.com/repos/o/r/pulls/1", "wget --quiet --no-check-certificate --tries=3 https://example.com/x"])(
    "lets the read %s through",
    async (command) => {
      const { stdout } = await logColumns(command);

      expect(stdout).toBe("");
    },
  );

  it("keeps a literal non-GitHub write with known options under egress", async () => {
    const { columns } = await logColumns("curl -sS --fail-with-body --no-progress-meter -X PUT https://example.com/x");

    expect(columns).toEqual(["deny", "EXT-CO", "private-egress", "bash.egress.curl-upload", "coordinator+worker+headless"]);
  });

  it("lets a GET to a run-time URL through", async () => {
    const { stdout } = await logColumns('curl -X GET "$U"');

    expect(stdout).toBe("");
  });
});
