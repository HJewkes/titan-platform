import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function file(name: string, text: string, mode = 0o755): void {
  writeFileSync(join(home, name), text, { mode });
  chmodSync(join(home, name), mode);
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
  ])("denies a PATH the walk cannot read, then a searched command: %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBe("deny");
  });

  it.each(["PATH=$PATH:~/bin ls", 'export PATH="$HOME/bin:$PATH"; ls', "PATH=/usr/bin:/bin ls", "export PATH=$(pwd)/bin:$PATH; export X=1"])("passes %s, which runs no script", async (command) => {
    expect(await decision(command)).toBeNull();
  });

  it.each(["export PATH=.:$PATH; echo PATH=/usr/bin; s", "PATH=.:$PATH s PATH=/usr/bin", "PATH=~+:$PATH s", "PATH=~-/bin:$PATH s"])("keeps a relative PATH a later word or a tilde form does not reset: %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
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
    file(name, `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(`PATH=.:$PATH ${command}`)).toBe("deny");
    rmSync(join(home, name), { force: true });
  });

  it.each(["tar xf a.tar; PATH=.:$PATH n", "git checkout other; PATH=.:$PATH n", "make; PATH=.:$PATH n"])("refuses a file an earlier command may have made: %s", async (command) => {
    rmSync(join(home, "n"), { force: true });
    expect(await decision(command)).toBe("deny");
  });

  it.each(["cat a; PATH=.:$PATH n", "git status; PATH=.:$PATH n", "echo hi; PATH=.:$PATH n"])("passes an absent file after only readers: %s", async (command) => {
    rmSync(join(home, "n"), { force: true });
    expect(await decision(command)).toBeNull();
  });

  it.each([
    "PATH=.:$PATH bash -c s",
    "env PATH=. sh -c s",
    "PATH=. bash <<< s",
    "PATH=. find . -maxdepth 0 -exec s ;",
    "PATH=.:$PATH bash -c 'sh -c s'",
  ])("reads ./s for a shell run under a prefix PATH: %s", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    expect(await decision(command)).toBe("deny");
  });

  it.each([
    "/bin/cp s n; PATH=.:$PATH n",
    "./mk; PATH=.:$PATH n",
    ". ./mk.sh; PATH=.:$PATH n",
    "source ./mk.sh; PATH=.:$PATH n",
    `printf '${PUSH}\\n' | sort -o n; PATH=.:$PATH n`,
    "uniq a n; PATH=.:$PATH n",
    "git diff --output=n; PATH=.:$PATH n",
  ])("refuses a file an earlier unlisted program may have made: %s", async (command) => {
    file("mk", "#!/bin/bash\necho ok\n");
    file("mk.sh", "echo ok\n");
    rmSync(join(home, "n"), { force: true });
    expect(await decision(command)).toBe("deny");
  });

  it("passes a script run by path after PATH gains a directory under HOME", async () => {
    file("build.sh", "#!/bin/bash\necho ok\n");
    expect(await decision('export PATH="$HOME/bin:$PATH"; ./build.sh')).toBeNull();
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
    'eval "$(cat envf)"; s',
    "eval $(cat envf); s",
    'eval "$(< envf)"; s',
    "eval `cat envf`; s",
    'eval "$(direnv export bash)"; s',
    'eval "$(direnv export bash)"; bash -c s',
    `eval "$(cat envf)"; printf '#!/bin/bash\\n${PUSH}\\n' > s; s`,
  ])("reads ./s after %s, whose text may list the working directory", async (command) => {
    file("s", `#!/bin/bash\n${PUSH}\n`);
    file("envf", "PATH=.\n");
    expect(await decision(command)).toBe("deny");
  });

  it("reads a non-executable ./s the line makes executable first", async () => {
    file("s", `#!/bin/bash\n${PUSH}\n`, 0o644);
    file("envf", "PATH=.\n");
    expect(await decision('chmod +x s; eval "$(cat envf)"; s')).toBe("deny");
    file("s", `#!/bin/bash\n${PUSH}\n`);
  });

  it.each([
    ["eval \"$(pyenv init -)\"; python -V", "python"],
    ['eval "$(docker-machine env)"; docker ps', "docker"],
    ['eval "$(direnv export bash)"; make', "make"],
    ['eval "$(fnm env)"; node -v', "node"],
    ['eval "$(brew shellenv)"; brew list', "brew"],
    ['eval "$(conda shell.bash hook)"; conda activate x; python run.py', "conda"],
  ])("passes %s with a directory named %s in the working directory", async (command, name) => {
    mkdirSync(join(home, name), { recursive: true });
    expect(await decision(command)).toBeNull();
  });

  it.each([
    'eval "$(rbenv init -)"; ls',
    'eval "$(ssh-agent -s)"; ssh-add',
    'eval "$(brew shellenv)"; brew list',
    'eval "$(pyenv init -)"; python -V',
    'eval "$(direnv export bash)"; make',
  ])("passes the common line %s", async (command) => {
    expect(await decision(command)).toBeNull();
  });
});

describe("an eval or a nameref that does not touch PATH", () => {
  it.each(['eval "$(rbenv init -)"', 'eval "X=1"; ls', "declare -A map; ls", 'export PATH="$HOME/bin:$PATH"; eval "FOO=1"; ls'])("passes %s", async (command) => {
    expect(await decision(command)).toBeNull();
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
