import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main";
const CAP = 64 * 1024;
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-by-path-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

/** Writes `name` under `home` and returns the command that runs it by path. */
function file(name: string, text: string | Buffer, mode = 0o755): string {
  writeFileSync(join(home, name), text, { mode });
  chmodSync(join(home, name), mode);
  return `./${name}`;
}

const HOST_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };

/** A synthetic 64-bit little-endian ELF: a header, `phnum` program headers (the first a PT_LOAD), a newline, then `body`. */
function elf(options: { machine?: number; phnum?: number; phentsize?: number; ptype?: number; nulFree?: boolean; body?: string; padding?: number }): Buffer {
  const { machine = HOST_MACHINE[process.arch] ?? 0x3e, phnum = 1, phentsize = 56, ptype = 1, nulFree = false, body = "", padding = 0 } = options;
  const header = Buffer.alloc(64 + 56);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, nulFree ? 3 : 0, nulFree ? 0x0a : 0]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(machine, 18);
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(64n, 32);
  header.writeUInt16LE(phentsize, 54);
  header.writeUInt16LE(phnum, 56);
  header.writeUInt32LE(ptype, 64);
  return Buffer.concat([header, Buffer.from(`\n${body}`), Buffer.alloc(padding)]);
}

async function decision(command: string): Promise<string | null> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const { stdout } = await handle(event, {}, port);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

/** The hook's answer as written; a deny reason's backticks and `#!` survive its JSON encoding unescaped. */
async function denyAnswer(command: string): Promise<string> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  return (await handle(event, {}, port)).stdout;
}

describe("a file run by path whose name does not end in .sh", () => {
  it.each(["s", "s.bash", "s.zsh", "s.txt"])("denies a push in the body of ./%s", async (name) => {
    expect(await decision(file(name, `#!/bin/bash\n${PUSH}\n`))).toBe("deny");
  });

  it("denies a push in the body of a script named by its absolute path", async () => {
    file("abs", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(join(home, "abs"))).toBe("deny");
  });

  it("denies a push in a script with no #! line", async () => {
    expect(await decision(file("bare", `${PUSH}\n`))).toBe("deny");
  });

  it.each([
    ["a -c shell", "#!/bin/bash -c"],
    ["env -S handing the body to a -c shell", `#!/usr/bin/env -S bash -c '${PUSH}'`],
    ["an unlisted interpreter", "#!/usr/local/bin/python3"],
  ])("denies an opaque #! line: %s", async (_, first) => {
    expect(await decision(file("o", `${first}\necho ok\n`))).toBe("deny");
  });

  it("names the #! line, not an unreadable file, as the reason it denies a node script run by path", async () => {
    const reason = await denyAnswer(file("tool.mjs", `#!/usr/bin/env node\nconsole.log("ok");\n`));
    expect(reason).toContain("`#!` line");
    expect(reason).toContain("`node ./x`");
    expect(reason).not.toContain("FIFO");
  });

  it("follows that advice: the same script run as node ./tool.mjs passes clean, and its body is still read", async () => {
    file("tool.mjs", `#!/usr/bin/env node\nconsole.log("ok");\n`);
    expect(await decision("node ./tool.mjs")).toBeNull();
    file("writer.mjs", `#!/usr/bin/env node\nrequire("fs").writeFileSync("${home}/.claude/settings.json", "{}");\n`);
    expect(await decision("node ./writer.mjs")).toBe("deny");
  });

  it("still gives the unreadable-file reason for a file the guard cannot read", async () => {
    expect(await denyAnswer(file("locked2", `#!/usr/bin/env node\n`, 0o000))).toContain("FIFO");
  });

  it("denies a file that only begins with an ELF magic and is larger than the read cap", async () => {
    expect(await decision(file("magic", Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(CAP + 400)])))).toBe("deny");
  });

  it("denies a file the guard cannot read", async () => {
    expect(await decision(file("locked", `#!/bin/bash\necho ok\n`, 0o000))).toBe("deny");
  });

  it.each(["#!/bin/bash\necho ok\n", "#!/usr/bin/env bash\necho ok\n", "echo ok\n"])("passes a clean script %j", async (text) => {
    expect(await decision(file("clean", text))).toBeNull();
  });

  it("denies a path that names no file, as a missing .sh already is", async () => {
    expect(await decision("./missing")).toBe("deny");
  });
});

describe("a native program run by path", () => {
  it.each(["/usr/bin/git status", "/bin/ls", "/usr/bin/env true"])("passes %s", async (command) => {
    if (!existsSync(command.split(" ")[0] ?? "")) return;
    expect(await decision(command)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("passes a structurally valid ELF for this host that is larger than the read cap", async () => {
    expect(await decision(file("valid", elf({ padding: CAP + 400 })))).toBeNull();
  });

  it.each(["./fake", "env ./fake", "xargs ./fake", "find . -exec ./fake ;"])("denies a fake ELF header with a NUL and a push body, run as %s", async (command) => {
    file("fake", elf({ machine: 0x1234, body: `${PUSH}\n` }));
    expect(await decision(command)).toBe("deny");
  });

  it("denies an ELF for another machine with a push body", async () => {
    expect(await decision(file("other", elf({ machine: 0x1234, body: `${PUSH}\n` })))).toBe("deny");
  });

  it("denies an ELF with no program headers and a push body", async () => {
    expect(await decision(file("nophdr", elf({ phnum: 0, body: `${PUSH}\n` })))).toBe("deny");
  });

  it.each([
    ["a program header size the loader rejects", { phentsize: 48 }],
    ["no PT_LOAD segment", { ptype: 4 }],
    ["a newline before any NUL", { nulFree: true }],
  ])("denies an ELF with %s and a push body", async (_, options) => {
    expect(await decision(file("odd", elf({ ...options, body: `${PUSH}\n` })))).toBe("deny");
  });

  it.each(["true >/dev/null; /usr/bin/git status", "echo x 2>log; /bin/ls"])("passes %s", async (command) => {
    if (!existsSync(command.split(" ").at(-2) === "/usr/bin/git" ? "/usr/bin/git" : "/bin/ls")) return;
    expect(await decision(command)).toBeNull();
  });

  it("passes a valid ELF after a write to another file", async () => {
    file("quiet", elf({ padding: CAP + 400 }));
    expect(await decision("echo x > ./other.log; ./quiet")).toBeNull();
  });

  it("denies a valid ELF the line has just overwritten with text it cannot model", async () => {
    file("over2", elf({ padding: 100 }));
    expect(await decision(`printf '%s\\n' '${PUSH}' > ./over2; ./over2`)).toBe("deny");
  });

  it("denies a valid ELF after a write the line cannot place", async () => {
    file("moved", elf({ padding: 100 }));
    expect(await decision(`f=./moved; printf '%s\\n' '${PUSH}' > "$f"; ./moved`)).toBe("deny");
  });

  it("denies a valid ELF the line has just overwritten with a push", async () => {
    file("over", elf({ padding: 100 }));
    expect(await decision(`echo '${PUSH}' > ./over; ./over`)).toBe("deny");
  });
});

describe("a FIFO run by path", () => {
  // The built hook runs in a child: opening a FIFO blocks the thread, so only a process timeout can show it.
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  spawnSync("mkfifo", [join(home, "p")]);
  symlinkSync("p", join(home, "link-to-p"));

  function hook(command: string): { returned: boolean; stdout: string } {
    const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event, env: { ...process.env, HOME: home }, encoding: "utf-8", timeout: 4000 });
    return { returned: run.error === undefined, stdout: run.stdout };
  }

  it.each([["./p"], [join(home, "p")], ["env ./p"], ["./link-to-p"], [`./p; ${PUSH}`]])("returns a denial for %s", (command) => {
    const { returned, stdout } = hook(command);
    expect(returned).toBe(true);
    expect(stdout).toContain('"permissionDecision":"deny"');
  });
});

describe("an ELF program-header table the Linux loader bounds", () => {
  it.each([[0], [1171]])("denies e_phnum %i with a push body", async (phnum) => {
    expect(await decision(file("count", elf({ phnum, body: `${PUSH}\n`, padding: 70000 })))).toBe("deny");
  });
});
