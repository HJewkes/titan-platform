import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const DOC = "~/.config/titan-coordinator/coordinator.json";
const ts = new Date("2026-01-02T03:04:05.000Z");

/** The console's installed bin, a node script, is the only file on this filesystem, beside a link to its CLI script. */
const BIN = "/home/you/.local/bin/titan-console";
const LINKS: Record<string, string> = {
  [BIN]: BIN,
  [`${REPO}/c.js`]: `${REPO}/apps/console/dist/cli.js`,
};
const binOnlyFs: ReadFs = {
  realpath: (p) => {
    const real = LINKS[p];
    if (real !== undefined) return real;
    throw new Error("ENOENT");
  },
  readHead: (p) => {
    if (p === BIN) return "#!/usr/bin/env node\nimport './cli.js';\n";
    throw new Error("ENOENT");
  },
  isFile: (p) => p === BIN,
};

const port: HookPort = { context: nodeContext(HOME, binOnlyFs), now: () => ts, loadDecide: async () => decide };
interface Verdict {
  decision: string | null;
  action: string | null;
}

async function hook(toolName: string, toolInput: Record<string, unknown>): Promise<Verdict> {
  const stdin = JSON.stringify({ tool_name: toolName, session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: toolInput });
  const { stdout, log } = await handle(stdin, { CLAUDE_AGENT_ID: "impl-7" }, port);
  if (stdout === "") return { decision: null, action: null };
  const decision = /"permissionDecision":"(\w+)"/.exec(stdout)?.[1] ?? "unparsed";
  return { decision, action: log[0]?.split("\t")[3] ?? null };
}

const REFUSED: Verdict = { decision: "deny", action: "authority-config" };
const PASSES: Verdict = { decision: null, action: null };

const bash = (command: string) => hook("Bash", { command });

describe("an agent session writing the fleet config store", () => {
  it.each([
    ["sed -i", `sed -i 's/"implementers": 6/"implementers": 60/' ${DOC}`],
    ["a truncating redirect", `echo '{}' > ${DOC}`],
    ["an appending redirect", `echo '{}' >> ${DOC}`],
    ["tee", `jq '.seats' /tmp/new.json | tee ${DOC}`],
    ["cp onto the file", `cp /tmp/new.json ${DOC}`],
    ["cp into the directory", "cp /tmp/coordinator.json ~/.config/titan-coordinator/"],
    ["mv onto the file", `mv /tmp/new.json ${DOC}`],
    ["python -c open(..., 'w')", `python3 -c "open('/home/you/.config/titan-coordinator/coordinator.json', 'w').write('{}')"`],
    ["a quoted path", `echo '{}' > "${HOME}/.config/titan-coordinator/coordinator.json"`],
    ["a $HOME path", "echo '{}' > $HOME/.config/titan-coordinator/coordinator.json"],
    ["a ${HOME} path", "echo '{}' > \"${HOME}/.config/titan-coordinator/coordinator.json\""],
    ["a ~ path", "echo '{}' > ~/.config/titan-coordinator/coordinator.json"],
    ["cd then a relative path", "cd ~/.config/titan-coordinator && echo '{}' > coordinator.json"],
    ["cd .. then a relative path", "cd ~/.config && sed -i s/6/60/ titan-coordinator/coordinator.json"],
    ["the macOS config directory", "echo '{}' > ~/Library/Preferences/titan-coordinator/coordinator.json"],
    ["a new file beside the document", "echo x > ~/.config/titan-coordinator/coordinator.json.tmp"],
    ["the console LAN secret", "echo new > ~/.local/state/titan-console/lan.token"],
    ["an owner action record", "cp /tmp/forged.json ~/.local/state/titan-console/owner-actions/a9.json"],
    ["the config revision log", "echo '{}' >> ~/.local/state/titan-console/config/log.jsonl"],
    ["removing the revision log", "rm -rf ~/.local/state/titan-console/config"],
    ["removing the state dir", "rm -rf ~/.local/state/titan-console"],
    ["removing the state dir by a trailing-slash path", "rm -rf ~/.local/state/titan-console/"],
    ["moving the state dir away", "mv ~/.local/state/titan-console /tmp/old-console"],
    ["moving a forged dir over it", "mv /tmp/forged ~/.local/state/titan-console"],
    ["copying a forged dir over it", "cp -r /tmp/forged ~/.local/state/titan-console"],
    ["syncing a forged dir over it", "rsync -a --delete /tmp/forged/ ~/.local/state/titan-console/"],
    ["linking a forged dir over it", "ln -sfn /tmp/forged ~/.local/state/titan-console"],
    ["locking the owner out of it", "chmod 000 ~/.local/state/titan-console"],
    ["hard-linking the document", "ln ~/.config/titan-coordinator/coordinator.json ~/h"],
    ["hard-linking it with -f", "ln -f ~/.config/titan-coordinator/coordinator.json /tmp/h"],
    ["hard-linking the LAN secret", "ln ~/.local/state/titan-console/lan.token ~/t"],
    ["hard-linking through cp -l", "cp -l ~/.config/titan-coordinator/coordinator.json ~/h"],
    ["hard-linking through cp --link", "cp --link ~/.config/titan-coordinator/coordinator.json ~/h"],
    ["hard-linking a tree through cp -al", "cp -al ~/.local/state/titan-console/config /tmp/c"],
    ["hard-linking the Claude settings", "ln ~/.claude/settings.json ~/s"],
    ["ln with -s after --, which is a file name", "ln -- ~/.config/titan-coordinator/coordinator.json -s"],
    ["ln -f with -s after --", "ln -f -- ~/.local/state/titan-console/lan.token -s"],
    ["ln with a file named -s right after --", "ln -- -s ~/.config/titan-coordinator/coordinator.json ~/links/"],
    ["ln with -s after an operand, a file to BSD ln", "ln ~/.config/titan-coordinator/coordinator.json -s"],
    ["ln whose -s is the -S suffix value", "ln -S -s ~/.config/titan-coordinator/coordinator.json ~/h"],
    ["ln whose -s is the -t target directory", "ln -t -s ~/.config/titan-coordinator/coordinator.json"],
    ["cp whose -l comes before --", "cp -l -- ~/.config/titan-coordinator/coordinator.json ~/h"],
    ["a redirect whose runner moves only the command", "cd ~/.config/titan-coordinator && pnpm -C /tmp exec node a.js > coordinator.json"],
  ])("refuses %s", async (_form, command) => {
    expect(await bash(command)).toEqual(REFUSED);
  });

  it.each([
    ["Write", "/home/you/.config/titan-coordinator/coordinator.json"],
    ["Edit", "/home/you/.config/titan-coordinator/coordinator.json"],
    ["MultiEdit", "/home/you/Library/Preferences/titan-coordinator/coordinator.json"],
    ["Write", "/home/you/.local/state/titan-console/owner-actions/a1.json"],
    ["Edit", "/home/you/.local/state/titan-console/config/log.jsonl"],
    ["Write", "/home/you/.local/state/titan-console/lan.token"],
  ])("refuses a %s of %s", async (toolName, filePath) => {
    expect(await hook(toolName, { file_path: filePath, content: "{}" })).toEqual(REFUSED);
  });
});

describe("an agent session minting or resetting the owner's console login", () => {
  it.each([
    "titan-console login-link",
    "titan-console token rotate",
    "env titan-console login-link",
    "command titan-console login-link",
    "env -i PATH=/usr/bin titan-console token rotate",
    "npx titan-console login-link",
    "pnpm exec titan-console token rotate",
    "nohup titan-console login-link",
    "'titan-console' login-link",
    'titan-console "$VERB"',
    'titan-console token "$VERB"',
    "node apps/console/dist/cli.js login-link",
    "tsx apps/console/server/cli.ts token rotate",
    "node node_modules/titan-console/dist/cli.js login-link",
    "V=login-link; titan-console $V",
    "C=titan-console; $C login-link",
    "bash -c 'titan-console login-link'",
    "sh -c \"titan-console token rotate\"",
    "echo titan-console login-link | sh",
    "xargs titan-console <<< login-link",
    "titan-console config import ./autonomy",
    "titan-console config import ./autonomy --limits limits.json",
    "env titan-console config import ./autonomy",
    "command titan-console config import ./autonomy",
    "npx titan-console config import ./autonomy",
    "pnpm exec titan-console config import ./autonomy",
    "nohup titan-console config import ./autonomy",
    "'titan-console' config 'import' ./autonomy",
    'titan-console config "$VERB" ./autonomy',
    "node apps/console/dist/cli.js config import ./autonomy",
    "tsx apps/console/server/cli.ts config import ./autonomy",
    "bash -c 'titan-console config import ./autonomy'",
    'sh -c "titan-console config import ./autonomy"',
    'titan-console "token rotate"',
    'titan-console "token  rotate"',
    'node apps/console/dist/cli.js "token rotate"',
    'titan-console "config import" ./autonomy',
    'titan-console " login-link"',
    "cd apps/console && tsx server/cli.ts login-link",
    "cd apps/console && node dist/cli.js login-link",
    "cd apps/console/dist && node cli.js token rotate",
    "cd apps && node ./console/dist/cli.js login-link",
    'cd "$D" && node dist/cli.js login-link',
    "node c.js login-link",
    "node apps/console/dist/cli login-link",
    "tsx apps/console/server/cli token rotate",
    "cd apps/console && node dist/cli login-link",
    "node -r ./apps/console/dist/cli.js - login-link",
    "node --require ./apps/console/dist/cli - login-link",
    "node --import=./apps/console/dist/cli.js x.js token rotate",
    "node -r ./apps/console/dist/cli.js -- x.js login-link",
    "node - login-link < apps/console/dist/cli.js",
    `node -e "import('./apps/console/dist/cli.js')" x login-link`,
    "pnpm --filter titan-console exec node dist/cli.js login-link",
    "pnpm -F titan-console exec tsx server/cli.ts login-link",
    "pnpm -C apps/console exec node dist/cli.js login-link",
    "pnpm --dir apps/console exec node dist/cli.js token rotate",
    "pnpm --dir=apps/console exec node dist/cli.js login-link",
    "pnpm -r exec node dist/cli.js login-link",
    'pnpm --filter "$P" exec node dist/cli.js login-link',
    "npm -C apps/console exec node dist/cli.js login-link",
    "npm --prefix apps/console exec -- node dist/cli.js login-link",
    "npm -w titan-console exec -- tsx server/cli.ts config import ./autonomy",
    "yarn --cwd apps/console exec node dist/cli.js login-link",
    "bun --cwd apps/console x tsx server/cli.ts login-link",
    "env -C apps/console node dist/cli.js login-link",
    "env --chdir=apps/console tsx server/cli.ts login-link",
    "sudo -D /home/you/projects/app/apps/console node dist/cli.js login-link",
  ])("refuses %s", async (command) => {
    expect(await bash(command)).toEqual(REFUSED);
  });

  it("refuses the installed bin run by path, since its node #! line is one the guard cannot follow", async () => {
    expect((await bash(`${BIN} login-link`)).decision).toBe("deny");
  });
});

describe("what keeps passing", () => {
  it.each([
    `cat ${DOC}`,
    `grep -n implementers ${DOC}`,
    `jq '.seats' ${DOC}`,
    `jq . < ${DOC}`,
    `cp ${DOC} /tmp/coordinator-copy.json`,
    `diff ${DOC} /tmp/coordinator-copy.json`,
    "ls ~/.local/state/titan-console/owner-actions",
    "cat ~/.local/state/titan-console/config/log.jsonl",
    "titan-console",
    "titan-console --help",
    "titan-console inbox file -",
    "titan-console rounds import ./round-7 --json",
    "titan-console rounds withdraw r-3 --reason closed",
    "titan-console token",
    "titan-console config compare-tree",
    "env titan-console config compare-tree",
    "node apps/console/dist/cli.js config compare-tree",
    "titan-console config",
    'titan-console "rounds import" ./round-7',
    "cd apps/console && node dist/cli.js rounds import ./round-7",
    "node dist/cli.js login-link",
    "node scripts/cli.ts token rotate",
    "node apps/console/dist/cli.js rounds import ./round-7",
    "grep -rn login-link apps/console/server",
    "echo x > ~/.local/state/titan-console/rounds/r-1/note.txt",
    "echo x > ~/.config/titan-coordinator-notes.md",
    "ln -s -- ~/.config/titan-coordinator/coordinator.json ~/view.json",
    "ln --symbolic ~/.config/titan-coordinator/coordinator.json ~/view.json",
    "ln -fs ~/.config/titan-coordinator/coordinator.json ~/view.json",
    "cp -- ~/.config/titan-coordinator/coordinator.json -l",
    "node -r ./scripts/setup.js scripts/run.js login-link",
    "node --import tsx scripts/build.ts token rotate",
    "node -r ./apps/console/dist/cli.js",
    `node -e "console.log(1)" login-link`,
    "node apps/console/dist/cli rounds import ./round-7",
    "ls ~/.local/state/titan-console",
    "cd ~/.local/state/titan-console && ls rounds",
    "mkdir -p ~/.local/state/titan-console/rounds/r-2",
    "cp -r ./round-7 ~/.local/state/titan-console/rounds/",
    "cat ~/.local/state/titan-console/rounds/r-1/frame.json",
    "ln -s ~/.config/titan-coordinator/coordinator.json ~/view.json",
    "ln -sf ~/.config/titan-coordinator/coordinator.json /tmp/view.json",
    "pnpm --filter titan-console exec node dist/cli.js rounds import ./round-7",
    "pnpm -C apps/console exec node dist/cli.js --help",
    "pnpm --filter app exec node scripts/build.js login",
    "env -C apps/console node dist/cli.js rounds withdraw r-3 --reason closed",
  ])("%s", async (command) => {
    expect(await bash(command)).toEqual(PASSES);
  });

  it("allows a Read of the materialized document", async () => {
    expect(await hook("Read", { file_path: "/home/you/.config/titan-coordinator/coordinator.json" })).toEqual(PASSES);
  });
});
