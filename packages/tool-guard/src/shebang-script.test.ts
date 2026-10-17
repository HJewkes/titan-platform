import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { parseShebang } from "./shebang.js";

const PUSH = "git push origin HEAD:main";
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-shebang-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

/** Writes `name` under `home` with `first` as its first line and a harmless body, and returns the command that runs it by path. */
function script(name: string, first: string | null, body = "echo ok\n"): string {
  writeFileSync(join(home, name), first === null ? body : `${first}\n${body}`);
  return `./${name}`;
}

async function decision(command: string): Promise<string | null> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout } = await handle(event, {}, port);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

writeFileSync(join(home, "other.sh"), `${PUSH}\n`);

describe("a script run by path whose #! line the guard cannot follow", () => {
  it("denies a -s shell reading the pushed text from stdin", async () => {
    expect(await decision(`echo '${PUSH}' | ${script("s.sh", "#!/bin/bash -s")}`)).toBe("deny");
  });

  it("denies an operand script the kernel runs in its place", async () => {
    expect(await decision(script("o.sh", "#!/bin/bash ./other.sh"))).toBe("deny");
  });

  it.each([
    ["env -S with a push", `#!/usr/bin/env -S bash -c '${PUSH}'`],
    ["env -S handing the file to dash", `#!/usr/bin/env -S bash -c 'dash "$0"'`],
    ["a -xc cluster", "#!/bin/bash -xc"],
    ["a -ec cluster", "#!/bin/bash -ec"],
    ["a -cx cluster", "#!/bin/bash -cx"],
    ["zsh -fc", "#!/bin/zsh -fc"],
    ["-i", "#!/bin/bash -i"],
    ["-l", "#!/bin/bash -l"],
    ["-o posix", "#!/bin/bash -o posix"],
    ["-O extglob", "#!/bin/bash -O extglob"],
    ["--rcfile", "#!/bin/bash --rcfile x"],
    ["300 spaces", `#!${" ".repeat(300)}/bin/bash`],
    ["a blank after #!", "#! /bin/bash"],
    ["a NBSP after #!", "#! /bin/bash"],
    ["a leading BOM", "﻿#!/bin/bash"],
    ["a trailing CR", "#!/bin/bash\r"],
    ["a trailing blank", "#!/bin/bash "],
    ["an unlisted interpreter", "#!/usr/local/bin/python3"],
  ])("denies %s", async (_, first) => {
    expect(await decision(script("t.sh", first))).toBe("deny");
  });

  it("denies the operand file the kernel globs back onto itself", async () => {
    const name = "q;dash q?dash*.sh";
    writeFileSync(join(home, name), "#!/bin/bash -xc\necho ok\n");
    expect(await decision(`'./${name}'`)).toBe("deny");
  });

  it("denies the by-path run after the same file ran as an argument of bash", async () => {
    const run = script("memo.sh", "#!/bin/bash -s");
    expect(await decision(`bash ${run}; ${run}`)).toBe("deny");
  });
});

describe("a script run by path whose #! line the guard follows", () => {
  it.each([
    ["bash", "#!/bin/bash"],
    ["bash -e", "#!/bin/bash -e"],
    ["sh -eu", "#!/bin/sh -eu"],
    ["env bash", "#!/usr/bin/env bash"],
    ["no #! line", null],
  ])("reads %s as before", async (_, first) => {
    expect(await decision(script("c.sh", first))).toBeNull();
  });

  it("still denies a push in the body", async () => {
    expect(await decision(script("p.sh", "#!/bin/bash -e", `${PUSH}\n`))).toBe("deny");
  });

  it("does not read the #! line of a script a shell is handed", async () => {
    script("arg.sh", "#!/bin/bash -s");
    expect(await decision("bash ./arg.sh")).toBeNull();
  });
});

describe("parseShebang", () => {
  it.each([
    ["#!/bin/bash\nx", { kind: "shell", shell: "bash", flags: "" }],
    ["#!/usr/bin/bash -eu\nx", { kind: "shell", shell: "bash", flags: "eu" }],
    ["#!/usr/bin/env zsh", { kind: "shell", shell: "zsh", flags: "" }],
    ["echo hi\n", { kind: "none" }],
    ["# !/bin/bash\n", { kind: "none" }],
    ["", { kind: "none" }],
    ["#!/bin/bash -s\n", { kind: "opaque" }],
    ["﻿#!/bin/bash\n", { kind: "opaque" }],
    ["#!/usr/bin/env bash -e\n", { kind: "opaque" }],
  ])("reads %j", (text, expected) => {
    expect(parseShebang(text)).toEqual(expected);
  });
});
