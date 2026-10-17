import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main";
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-by-path-dyn-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

function file(name: string, text: string): void {
  writeFileSync(join(home, name), text, { mode: 0o755 });
  chmodSync(join(home, name), 0o755);
}

async function reply(command: string): Promise<string> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  return (await handle(event, {}, port)).stdout;
}

async function decision(command: string): Promise<string | null> {
  const stdout = await reply(command);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

describe("a by-path script named by a dynamic command word", () => {
  it.each(["f=./s; $f", 'f=./s.bash; "$f"', "$(echo ./s)", "`echo ./s`", 'f=./s; exec "$f"', 'f=./s; command $f'])("denies a push in the body of the file named by %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    file("s.bash", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBe("deny");
  });

  it("passes a plain non-pushing script named by a variable", async () => {
    file("s", "#!/bin/bash\necho ok\n");
    expect(await decision("f=./s; $f")).toBeNull();
  });
});

describe("a dynamic command word that names no path", () => {
  it.each(["$(command -v ls) -l", '"$EDITOR" notes.txt'])("passes %s", async (command) => {
    expect(await decision(command)).toBeNull();
  });
});

describe("a bare name found through a changed PATH", () => {
  it.each(["PATH=.:$PATH s", "export PATH=.:$PATH; s", "PATH=. s", "PATH=$PWD:$PATH s", "export PATH=./:/usr/bin; s", "PATH=:$PATH s", "env PATH=. s"])("denies a push in ./s for %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    `printf '#!/bin/bash\\n${PUSH}\\n' > n; chmod +x n; PATH=.:$PATH n`,
    "cp s n; PATH=.:$PATH n",
  ])("denies a file the line itself makes: %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    rmSync(join(home, "n"), { force: true });
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    "path=(. $path); s",
    "path[1]=.; s",
    "P=.; export PATH=$P:$PATH; s",
    "export PATH=$(pwd)/bin:$PATH; s",
    "printf -v PATH %s .; s",
    "read PATH <<< .; s",
    "PATH=.:$PATH $(echo s)",
    "export PATH=$(echo .):$PATH; s",
    "PATH[0]=.; s",
  ])("denies a PATH the walk cannot read, then a searched command: %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBe("deny");
  });

  it.each(["PATH=$PATH:~/bin ls", 'export PATH="$HOME/bin:$PATH"; ls', "PATH=/usr/bin:/bin ls", "export PATH=$(pwd)/bin:$PATH; export X=1"])("passes %s, which runs no script", async (command) => {
    expect(await decision(command)).toBeNull();
  });

  it("passes a non-pushing ./s under a changed PATH", async () => {
    file("s", "#!/bin/bash\necho ok\n");
    expect(await decision("PATH=.:$PATH s")).toBeNull();
  });

  it("passes a bare ls under the unchanged PATH", async () => {
    expect(await decision("ls")).toBeNull();
  });

  it("passes a bare name when PATH is only extended with an absolute directory", async () => {
    expect(await decision("export PATH=/usr/local/bin:$PATH; ls")).toBeNull();
  });
});

describe("an opaque #! line in a file run by path", () => {
  it("is refused with its own reason, not 'cannot read in full'", async () => {
    file("o", "#!/usr/local/bin/python3\nprint(1)\n");
    const stdout = await reply("./o");
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("#!");
    expect(stdout).not.toContain("cannot read in full");
  });
});
