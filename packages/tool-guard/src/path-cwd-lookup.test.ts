import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const PUSH = "git push origin HEAD:main";
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-guard-cwd-lookup-")));
const cwd = join(home, "app");
// A clean working directory for lines that must pass whatever the other rows leave in `cwd`.
const repo = join(home, "repo");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const port: HookPort = { context: nodeContext(home), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

function file(path: string, text: string, mode = 0o755): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}

const here = (name: string) => join(cwd, name);
const pushIn = (name: string) => file(here(name), `#!/bin/bash\n${PUSH}\n`);

async function reply(command: string, dir = cwd): Promise<string> {
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: dir, tool_input: { command } });
  return (await handle(event, {}, port)).stdout;
}

async function decision(command: string, dir = cwd): Promise<string | null> {
  const stdout = await reply(command, dir);
  return stdout === "" ? null : /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unknown";
}

mkdirSync(cwd, { recursive: true });
mkdirSync(repo, { recursive: true });

describe("a bare name a changed PATH may find in the working directory", () => {
  it.each([
    "PATH=.:$PATH s",
    "export PATH=.:$PATH; s",
    "PATH=. s",
    "PATH=$PWD:$PATH s",
    "export PATH=./:/usr/bin; s",
    "PATH=:$PATH s",
    "PATH=./.:$PATH s",
    "PATH=.//:$PATH s",
    "PATH=$PWD/.:$PATH s",
    "PATH=$PWD//:$PATH s",
    "PATH=~+/.:$PATH s",
    "PATH=bin/..:$PATH s",
    "env PATH=. s",
    "P=.; export PATH=$P:$PATH; s",
    'export PATH="$(pwd):$PATH"; s',
    'export PATH="$PWD:$PATH"; s',
    'D=.; export PATH="$D:$PATH"; s',
    'export PATH="$(echo .):$PATH"; s',
    'export PATH="$X:$PATH"; s',
    "source setp.sh; s",
    ". ./setp.sh; s",
    'eval "$(cat envf)"; s',
  ])("denies a push in ./s for %s", async (command) => {
    pushIn("s");
    file(here("setp.sh"), "PATH=.:$PATH\n", 0o644);
    file(here("envf"), "PATH=.\n", 0o644);
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    "path=(. $path); s",
    "path[1]=.; s",
    "export PATH=$(pwd)/bin:$PATH; s",
    "printf -v PATH %s .; s",
    "read PATH <<< .; s",
    "PATH[0]=.; s",
    "for PATH in .; do s; done",
    'eval "PATH=."; s',
    'eval "export PATH=.:$PATH"; s',
    'builtin eval "PATH=."; s',
    'command eval "PATH=."; s',
    "declare -n p=PATH; p=.; s",
    "typeset -n p=PATH; p=.; s",
    "local -n p=PATH; p=.; s",
    "eval 'path=(. $path)'; s",
    "mapfile PATH <<< .; s",
    "typeset path=(. $path); s",
    "declare -x PATH=$(echo .):$PATH; s",
    "export PATH=.:$PATH; echo PATH=/usr/bin; s",
    "PATH=.:$PATH s PATH=/usr/bin",
    "PATH=~+:$PATH s",
    "PATH=~-/bin:$PATH s",
    "((PATH=0)); s",
    "echo $(( $(PATH=.:$PATH s) ))",
  ])("takes a PATH the walk cannot read as a guess and reads ./s: %s", async (command) => {
    pushIn("s");
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    "PATH=.:$PATH bash -c s",
    "env PATH=.:/usr/bin:/bin sh -c s",
    "PATH=. bash <<< s",
    "PATH=. find . -maxdepth 0 -exec s ;",
    "PATH=.:$PATH bash -c 'sh -c s'",
    "PATH=.:$PATH env s",
    "PATH=.:$PATH nohup s",
  ])("carries a prefix PATH into the commands a shell or wrapper runs: %s", async (command) => {
    pushIn("s");
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    ["bash -c true", "bash"],
    ["python3 x.py", "python3"],
    ["nohup true", "nohup"],
    ["env true", "env"],
    ["timeout 5 true", "timeout"],
    ["print hi", "print"],
  ])("reads the file a changed PATH finds for the name in %s", async (command, name) => {
    pushIn(name);
    expect(await decision(`PATH=.:$PATH ${command}`)).toBe("deny");
    rmSync(here(name), { force: true });
  });

  it.each([`printf '#!/bin/bash\\n${PUSH}\\n' > n; chmod +x n; PATH=.:$PATH n`, `eval "$(cat envf)"; printf '#!/bin/bash\\n${PUSH}\\n' > n; n`])(
    "denies a file the line itself writes: %s",
    async (command) => {
      file(here("envf"), "PATH=.\n", 0o644);
      rmSync(here("n"), { force: true });
      expect(await decision(command)).toBe("deny");
    },
  );

  it("refuses an opaque #! file the line writes, with the reason ./n gets", async () => {
    rmSync(here("n"), { force: true });
    const stdout = await reply(`echo '#!/usr/bin/env -S bash -c "${PUSH}"' > n; chmod +x n; PATH=.:$PATH n`);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("#!");
  });

  it("reads a non-executable ./s the line makes executable first", async () => {
    file(here("s"), `#!/bin/bash\n${PUSH}\n`, 0o644);
    expect(await decision("chmod +x s; PATH=.:$PATH s")).toBe("deny");
  });
});

describe("a ./name the lookup cannot run or follow is skipped, never refused", () => {
  it.each([
    ["missing", () => rmSync(here("s"), { recursive: true, force: true })],
    ["not executable", () => file(here("s"), `#!/bin/bash\n${PUSH}\n`, 0o644)],
    ["a directory", () => mkdirSync(here("s"), { recursive: true })],
    ["behind an opaque #! line", () => file(here("s"), `#!/usr/bin/env -S bash -e\n${PUSH}\n`)],
    ["too large to read", () => file(here("s"), `#!/bin/bash\n${"echo ok\n".repeat(9000)}${PUSH}\n`)],
  ])("passes PATH=.:$PATH s when ./s is %s", async (_kind, arrange) => {
    rmSync(here("s"), { recursive: true, force: true });
    arrange();
    expect(await decision("PATH=.:$PATH s")).toBeNull();
    rmSync(here("s"), { recursive: true, force: true });
  });

  it.each(["tar xf a.tar; PATH=.:$PATH n", "make; PATH=.:$PATH n", "./mk; PATH=.:$PATH n", "git checkout other; PATH=.:$PATH n"])(
    "passes a name no file holds yet after a command that may make it: %s",
    async (command) => {
      file(here("mk"), "#!/bin/bash\necho ok\n");
      rmSync(here("n"), { force: true });
      expect(await decision(command)).toBeNull();
    },
  );

  it.each(["PATH=./bin:$PATH s", "PATH=bin s", 'export PATH="$PWD/bin:$PATH"; s'])("does not follow a relative subdirectory: %s", async (command) => {
    rmSync(here("s"), { recursive: true, force: true });
    file(here("bin/s"), `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBeNull();
    rmSync(here("bin"), { recursive: true, force: true });
  });

  it("passes a non-pushing ./s", async () => {
    file(here("s"), "#!/bin/bash\necho ok\n");
    expect(await decision("PATH=.:$PATH s")).toBeNull();
  });
});

describe("a PATH entry spelled like an internal marker is an ordinary directory", () => {
  // A relative subdirectory is not followed, so `@soft/s` is not read; the entry must not be taken for a guess at `.` either.
  it.each(["PATH=@soft s", "PATH=@soft:$PATH s", "export PATH=@soft:$PATH; s", "PATH=cwd s", "PATH=no-cwd:$PATH s"])("does not read ./s for %s", async (command) => {
    pushIn("s");
    file(here("@soft/s"), `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBeNull();
  });
});

describe("a line that only mentions path or PATH", () => {
  it.each([
    "cargo build --manifest-path=Cargo.toml",
    'gh api "repos/o/r/contents?path=a"',
    "grep -v path file.ts",
    "cat x | grep -v PATH",
    'git commit -m "read the config path"',
    'grep -rn "read.*path" src',
    "echo PATH=/usr/bin; ls",
    "ls PATH=. path=.",
  ])("passes %s", async (command) => {
    expect(await decision(command)).toBeNull();
  });
});

describe("an eval of text only known at run time", () => {
  it.each([
    "eval $(cat envf); s",
    'eval "$(< envf)"; s',
    "eval `cat envf`; s",
    'eval "$(direnv export bash)"; s',
    'eval "$(direnv export bash)"; bash -c s',
  ])("reads ./s after %s, whose text may list the working directory", async (command) => {
    pushIn("s");
    file(here("envf"), "PATH=.\n", 0o644);
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    ['eval "$(pyenv init -)"; python -V', "python"],
    ['eval "$(docker-machine env)"; docker ps', "docker"],
    ['eval "$(direnv export bash)"; make', "make"],
    ['eval "$(fnm env)"; node -v', "node"],
    ['eval "$(brew shellenv)"; brew list', "brew"],
    ['eval "$(conda shell.bash hook)"; conda activate x; python run.py', "conda"],
  ])("passes %s with a directory named %s in the working directory", async (command, name) => {
    mkdirSync(here(name), { recursive: true });
    expect(await decision(command)).toBeNull();
  });

  it.each(['eval "$(rbenv init -)"; ls', 'eval "$(ssh-agent -s)"; ssh-add', 'eval "X=1"; ls', "declare -A map; ls", 'export PATH="$HOME/bin:$PATH"; eval "FOO=1"; ls'])(
    "passes the common line %s",
    async (command) => {
      expect(await decision(command, repo)).toBeNull();
    },
  );
});

describe("an opaque #! line in a file run by path", () => {
  it("is refused with its own reason, not 'cannot read in full'", async () => {
    file(here("o"), "#!/usr/local/bin/python3\nprint(1)\n");
    const stdout = await reply("./o");
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("#!");
    expect(stdout).not.toContain("cannot read in full");
  });
});
