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

describe("a #!/usr/bin/env shell script on a line that changes PATH", () => {
  const ENV_BASH = "#!/usr/bin/env bash\necho ok\n";

  it.each([
    ["a PATH= prefix", "PATH=.:$PATH ./envp"],
    ["a PATH= prefix with a dynamic value", "PATH=$(pwd) ./envp"],
    ["an earlier assignment", "PATH=.:$PATH; ./envp"],
    ["export PATH=", "export PATH=.:$PATH; ./envp"],
    ["a PATH+= append", "PATH+=:. ./envp"],
    ["zsh's path=( )", "path=(. $path); ./envp"],
    ["a PATH= prefix behind env", "env PATH=. ./envp"],
    ["a quoted name in export", "export PA''TH=.:$PATH; ./envp"],
    ["a quoted name behind env", "env PA''TH=. ./envp"],
    ["a quoted assignment behind env", 'env "PATH"=. ./envp'],
    ["eval of a quoted name", "eval PA''TH=.; ./envp"],
    ["read", "read PATH <<< .; ./envp"],
    ["printf -v", "printf -v PATH %s .; ./envp"],
    ["a nameref", "declare -n r=PATH; r=.; ./envp"],
    ["a for loop", "for PATH in .; do ./envp; done"],
    ["a zsh path element", "path[1]=.; ./envp"],
    ["a write after a function that runs the script", "f(){ ./envp; }; PATH=.:$PATH; f"],
    ["a write after the script in a loop", "for i in 1 2; do ./envp; PATH=.:$PATH; done"],
    ["a write after the script", "./envp; PATH=.:$PATH"],
    ["an empty leading entry", "PATH=:$PATH; ./envp"],
    ["an empty trailing entry", "PATH=$PATH:; ./envp"],
    ["a relative entry", "PATH=bin:$PATH ./envp"],
    ["a sourced write after a function that runs the script", "f(){ ./envp; }; . ./src.sh; f"],
    ["a sourced write after the script in a loop", "for i in 1 2; do ./envp; . ./src.sh; done"],
    ["an unreadable source after a function that runs the script", "f(){ ./envp; }; source <(echo PATH=.); f"],
    ["a tilde under a relative HOME", "HOME=.; PATH=~/:$PATH ./envp"],
    ["a bare tilde under a HOME set on the same command", "HOME=. PATH=~:$PATH ./envp"],
    ["a tilde under an exported relative HOME", "export HOME=x; PATH=~/b:$PATH ./envp"],
    ["the kernel's name for the working directory", "printf x >bash; PATH=/proc/self/cwd:$PATH ./envp"],
    ["a numbered process's working directory", "PATH=/proc/1234/cwd:$PATH ./envp"],
    ["a descriptor directory", "PATH=/dev/fd/3:$PATH ./envp"],
    ["a doubled slash before the kernel's name", "PATH=/proc//self/./cwd:$PATH ./envp"],
    ["a dynamic store", "declare $X=.; ./envp"],
    ["declare -g", "declare -g PATH=.; ./envp"],
    ["a nameref to PATH", "declare -n p=PATH; p=.; ./envp"],
    ["printf -v through a name variable", 'p=PATH; printf -v "$p" .; ./envp'],
    ["eval of an export", 'eval "export PATH=."; ./envp'],
    ["a sourced process substitution", "source <(echo PATH=.); ./envp"],
    ["a PATH= prefix on sh -c", "PATH=.:$PATH /bin/sh -c ./envp"],
    ["a PATH= prefix on bash -c", "PATH=.:$PATH /bin/bash -c ./envp"],
    ["a PATH= prefix on find -exec ;", "PATH=.:$PATH find . -name envp -exec ./envp \\;"],
    ["a PATH= prefix on find -exec +", "PATH=.:$PATH find . -name envp -exec ./envp {} +"],
    ["a PATH= prefix on flock -c", "PATH=.:$PATH flock /tmp/l -c ./envp"],
    ["a PATH= prefix on watch", "PATH=. watch ./envp"],
    ["a PATH= prefix on parallel", "PATH=. parallel ./envp ::: a"],
    ["a subshell group", "{ PATH=.; }; ./envp"],
    ["a PATH= prefix on a function that runs the script", "f(){ ./envp; }; PATH=. f"],
    ["a HOME= prefix on a function that puts a tilde on PATH", "f(){ PATH=~/b:$PATH; ./envp; }; HOME=. f"],
    ["a PATH= prefix on : in sh -c", "sh -c 'PATH=. :; ./envp'"],
    ["a PATH= prefix on export in sh -c", "sh -c 'PATH=. export X; ./envp'"],
    ["a PATH= prefix on set in sh -c", "sh -c 'PATH=. set -e; ./envp'"],
    ["a PATH= prefix on readonly in sh -c", "sh -c 'PATH=. readonly X; ./envp'"],
    ["a PATH= prefix on unset in sh -c", "sh -c 'PATH=. unset X; ./envp'"],
    ["a PATH= prefix on times in sh -c", "sh -c 'PATH=. times; ./envp'"],
    ["a PATH= prefix on trap in sh -c", "sh -c 'PATH=. trap - INT; ./envp'"],
    ["a PATH= prefix on shift in sh -c", "sh -c 'PATH=. shift 0; ./envp'"],
    ["a PATH= prefix on break in a loop in sh -c", "sh -c 'for i in 1; do PATH=. break; done; ./envp'"],
    ["a PATH= prefix on continue in a loop in sh -c", "sh -c 'for i in 1; do PATH=. continue; done; ./envp'"],
    ["a PATH= prefix on return in a function in sh -c", "sh -c 'f(){ PATH=. return; }; f; ./envp'"],  ])("denies the script after %s", async (_, line) => {
    file("envp", ENV_BASH);
    file("src.sh", "PATH=.:$PATH\n");
    expect(await decision(line)).toBe("deny");
  });

  it.each(["#!/usr/bin/env sh\necho ok\n", "#!/usr/bin/env zsh\necho ok\n"])("denies %j after a PATH change", async (text) => {
    file("envp", text);
    expect(await decision("PATH=.:$PATH ./envp")).toBe("deny");
  });

  it("reads the script as before when PATH is unchanged", async () => {
    file("envp", ENV_BASH);
    expect(await decision("./envp")).toBeNull();
    file("envp2", `#!/usr/bin/env bash\n${PUSH}\n`);
    expect(await decision("./envp2")).toBe("deny");
  });

  it("denies the script after a shell is written into a directory the line puts on PATH", async () => {
    file("envp", ENV_BASH);
    const dir = join(home, "pd");
    expect(await decision(`echo x > ${dir}/bash; PATH=${dir}:$PATH ./envp`)).toBe("deny");
  });

  it.each([
    'export PATH="$HOME/bin:$PATH"; ./envp',
    "PATH=/usr/local/bin:$PATH ./envp",
    "PATH+=:/opt/tools ./envp",
    "PATH=$HOME/bin:$PATH:/usr/local/bin; ./envp",
    "PATH=~/bin:$PATH ./envp",
    "export PATH=\"$HOME/bin:$PATH\"; ./build.sh",
  ])("reads the script as before when the line puts only absolute directories on PATH: %s", async (line) => {
    file("envp", ENV_BASH);
    file("build.sh", ENV_BASH);
    expect(await decision(line)).toBeNull();
  });

  it("denies the script after a sourced file writes PATH", async () => {
    file("envp", ENV_BASH);
    file("src.sh", "PATH=.:$PATH\n");
    expect(await decision(". ./src.sh; ./envp")).toBe("deny");
  });

  it.each(["echo PATH=1 && ./envp", "./envp; echo PATH=x", "grep PATH= f; ./envp", "PATH=$PATH:~/bin ls; ./envp", 'export PATH="$HOME/bin:$PATH"', 'export PATH="$HOME/bin:$PATH"; git status', 'export PATH="$HOME/bin:$PATH"; npm test'])("reads the script as before for %s", async (line) => {
    file("envp", ENV_BASH);
    expect(await decision(line)).toBeNull();
  });

  it("does not take a variable that only ends in PATH for PATH", async () => {
    file("envp", ENV_BASH);
    expect(await decision("MYPATH=x ./envp")).toBeNull();
  });

  it("leaves a script with an absolute #! alone", async () => {
    file("absp", "#!/bin/bash\necho ok\n");
    expect(await decision("PATH=.:$PATH ./absp")).toBeNull();
  });
});

describe("PATH writes in a script the line runs, which follow bash's shells", () => {
  const ENV_BASH = "#!/usr/bin/env bash\necho ok\n";
  const WRITES = "#!/bin/bash\nPATH=.:$PATH\n";

  it.each([
    ["a script that sources a writer and then runs the env script", "./outer", `#!/bin/bash\n. ./writer\n./envp\n`],
    ["a sourced script that sources a writer, before the env script", ". ./outer; ./envp", `#!/bin/bash\n. ./writer\n`],
    ["a script that writes PATH and then runs the env script", "./outer", `#!/bin/bash\nPATH=.:$PATH\n./envp\n`],
    ["a script run with a PATH= prefix that runs the env script", "PATH=.:$PATH ./outer", "#!/bin/bash\n./envp\n"],
    ["a script run plain, then again with a PATH= prefix", "./outer; PATH=.:$PATH ./outer", "#!/bin/bash\n./envp\n"],
    ["a sourced writer after a script that runs the env script", "./outer; . ./writer", "#!/bin/bash\n./envp\n"],
  ])("denies %s", async (_, line, outer) => {
    file("envp", ENV_BASH);
    file("writer", WRITES);
    file("outer", outer);
    expect(await decision(line)).toBe("deny");
  });

  it.each([
    ["a script run by path that writes PATH", "./writer; ./envp"],
    ["a script run by bash that writes PATH", "bash ./writer; ./envp"],
    ["a script that runs a writer before the env script", "./outer"],
  ])("keeps the writes of %s in its own shell", async (_, line) => {
    file("envp", ENV_BASH);
    file("writer", WRITES);
    file("outer", "#!/bin/bash\n./writer\n./envp\n");
    expect(await decision(line)).toBeNull();
  });
});
