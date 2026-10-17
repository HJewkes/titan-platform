import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main";
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-nested-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

function file(name: string, text: string): void {
  writeFileSync(join(home, name), text, { mode: 0o755 });
  chmodSync(join(home, name), 0o755);
}

async function answer(command: string): Promise<string> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  return (await handle(event, {}, port)).stdout;
}

async function decision(command: string): Promise<string | null> {
  const stdout = await answer(command);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

describe("a by-path script run from inside a script the guard reads", () => {
  it.each([
    ["np", "./np"],
    ["push.sh", "./push.sh"],
    ["push.sh", "((./push.sh))"],
  ])("denies a push in %s run as %s from a.sh, sourced or run by path", async (name, inner) => {
    file(name, `#!/bin/bash\n${PUSH}\n`);
    file("a.sh", `#!/bin/bash\n${inner}\n`);
    expect(await decision(". ./a.sh")).toBe("deny");
    expect(await decision("./a.sh")).toBe("deny");
  });

  it("passes when the by-path scripts it runs are harmless", async () => {
    file("quiet", "#!/bin/bash\necho ok\n");
    file("b.sh", "#!/bin/bash\n./quiet\n");
    expect(await decision(". ./b.sh")).toBeNull();
    expect(await decision("./b.sh")).toBeNull();
  });

  it("denies a push one level further down, at the cap", async () => {
    file("deep", `#!/bin/bash\n${PUSH}\n`);
    file("mid", "#!/bin/bash\n./deep\n");
    file("top.sh", "#!/bin/bash\n./mid\n");
    expect(await decision("./top.sh")).toBe("deny");
  });

  it("refuses a chain of by-path scripts past the cap even when every body is harmless", async () => {
    file("l4", "#!/bin/bash\necho ok\n");
    file("l3", "#!/bin/bash\n./l4\n");
    file("l2", "#!/bin/bash\n./l3\n");
    file("l1.sh", "#!/bin/bash\n./l2\n");
    const out = await answer("./l1.sh");
    expect(out).toContain('"permissionDecision":"deny"');
  });

  it("refuses a script that runs itself", async () => {
    file("loop.sh", "#!/bin/bash\n./loop.sh\n");
    expect(await decision("./loop.sh")).toBe("deny");
  });
});
