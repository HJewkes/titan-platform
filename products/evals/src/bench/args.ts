import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Arm, Track } from "./arms.js";

/** Every way out of the sandbox a job could reach: remotes, GitHub, the network, and the operator's own CLIs. */
export const DENIED_TOOLS = [
  "Agent",
  "WebFetch",
  "WebSearch",
  "Bash(gh:*)",
  "Bash(git push:*)",
  "Bash(git fetch:*)",
  "Bash(git pull:*)",
  "Bash(git remote:*)",
  "Bash(git clone:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(titan-factory:*)",
  "Bash(agent-chat:*)",
  "Bash(active-work:*)",
  "Bash(titan-console:*)",
] as const;

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(rg:*)", "Bash(git diff:*)"];

export const TRACK_TOOLS: Record<Track, { allowed: readonly string[]; denied: readonly string[] }> = {
  r: { allowed: READ_ONLY_TOOLS, denied: [...DENIED_TOOLS, "Write", "Edit", "NotebookEdit"] },
  i: { allowed: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"], denied: DENIED_TOOLS },
  p: { allowed: READ_ONLY_TOOLS, denied: [...DENIED_TOOLS, "Write", "Edit", "NotebookEdit"] },
};

export const TRACK_TIMEOUT_SECS: Record<Track, number> = { r: 900, i: 2700, p: 1200 };

/** Operator state a job must never read; HOME is replaced, so these are named by the operator's real home. */
const OPERATOR_STATE = [".agent-chat", ".claude", ".claude-profiles", ".config/gh", ".ssh", ".aws", ".npmrc"];

interface SettingsOptions {
  operatorHome: string;
  jobsDir: string;
  /** Bubblewrap needs unprivileged user namespaces; a host that restricts them fails every Bash call, so it is opt-in. */
  osSandbox: boolean;
}

/**
 * The run's `--settings` file: the flag deny list again plus Read denies for operator state. Prefix rules miss
 * `sh -c '/usr/bin/curl …'` (S1 smoke); the OS sandbox closes that, with no network, the Read denies applied to every
 * process, and writes limited to the workspace and the run's job dirs. It refuses to start when bubblewrap cannot.
 */
export function benchSettings(denied: readonly string[], options: SettingsOptions) {
  const home = options.operatorHome.replace(/\/+$/, "");
  const reads = OPERATOR_STATE.map((dir) => `Read(/${home}/${dir}/**)`);
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { allowWrite: [options.jobsDir] },
  };
  return { permissions: { deny: [...denied, ...reads] }, ...(options.osSandbox && { sandbox }) };
}

/**
 * Every non-Anthropic connection goes to a closed local port, so `/usr/bin/curl` or `/usr/bin/gh` by absolute path
 * cannot reach the network even where no deny rule matches. claude itself reaches its API through NO_PROXY.
 */
const DEAD_PROXY = "http://127.0.0.1:9";
const PROXY_ENV = [
  ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map((name) => `${name}=${DEAD_PROXY}`),
  ...["NO_PROXY", "no_proxy"].map((name) => `${name}=.anthropic.com,anthropic.com,.claude.ai,claude.ai,.claude.com,claude.com`),
];

export interface JobArgs {
  arm: Arm;
  prompt: string;
  cwd: string;
  jobDir: string;
  configDir: string;
  path: string;
  settingsPath: string;
  sessionId: string;
  timeoutSecs: number;
  allowedTools: readonly string[];
  deniedTools: readonly string[];
  appendSystemPromptFile?: string;
}

export interface JobCommand {
  file: string;
  args: string[];
  cwd: string;
}

/** `env -i` so no operator variable (tokens, PATH, HOME) leaks into the job; the timeout wraps only claude. */
export function buildJobCommand(job: JobArgs, exists: (path: string) => boolean = existsSync): JobCommand {
  const home = join(job.jobDir, "home");
  const env = [
    `PATH=${job.path}`,
    `HOME=${home}`,
    `XDG_CONFIG_HOME=${join(home, ".config")}`,
    "LANG=C.UTF-8",
    `CLAUDE_CONFIG_DIR=${job.configDir}`,
    "NODE_OPTIONS=--max-old-space-size=4096",
    ...PROXY_ENV,
  ];
  const timeout = ["timeout", "-k", "30", String(job.timeoutSecs)];
  return { file: "env", args: ["-i", ...env, ...timeout, "claude", ...claudeArgs(job, exists)], cwd: job.cwd };
}

function claudeArgs(job: JobArgs, exists: (path: string) => boolean): string[] {
  const append = job.appendSystemPromptFile;
  return [
    "-p",
    job.prompt,
    ...["--model", job.arm.model, "--effort", job.arm.effort],
    ...["--output-format", "json", "--session-id", job.sessionId],
    ...["--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
    ...["--settings", job.settingsPath, "--permission-mode", "acceptEdits"],
    ...["--allowedTools", ...job.allowedTools],
    ...["--disallowedTools", ...job.deniedTools],
    ...(append !== undefined && exists(append) ? ["--append-system-prompt-file", append] : []),
  ];
}
