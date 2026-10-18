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

/** The console's installed bin, a node script, is the only file on this filesystem. */
const BIN = "/home/you/.local/bin/titan-console";
const binOnlyFs: ReadFs = {
  realpath: (p) => {
    if (p === BIN) return p;
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
  const decision = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
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
    "node apps/console/dist/cli.js rounds import ./round-7",
    "grep -rn login-link apps/console/server",
    "echo x > ~/.local/state/titan-console/rounds/r-1/note.txt",
    "echo x > ~/.config/titan-coordinator-notes.md",
  ])("%s", async (command) => {
    expect(await bash(command)).toEqual(PASSES);
  });

  it("allows a Read of the materialized document", async () => {
    expect(await hook("Read", { file_path: "/home/you/.config/titan-coordinator/coordinator.json" })).toEqual(PASSES);
  });
});
