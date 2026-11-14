import { describe, expect, it } from "vitest";
import { benchSettings, buildJobCommand, DENIED_TOOLS, TRACK_TOOLS, type JobArgs } from "./args.js";
import { TRACK_ARMS, TRACKS } from "./arms.js";

const base = (overrides: Partial<JobArgs> = {}): JobArgs => ({
  arm: { id: "S-high", model: "claude-sonnet-5-5", effort: "high" },
  prompt: "Do the task.",
  cwd: "/work/job-1/ws",
  jobDir: "/work/job-1",
  configDir: "/profiles/bench",
  path: "/work/bin",
  settingsPath: "/work/bench-settings.json",
  sessionId: "00000000-0000-4000-8000-000000000001",
  timeoutSecs: 900,
  allowedTools: TRACK_TOOLS.r.allowed,
  deniedTools: TRACK_TOOLS.r.denied,
  ...overrides,
});

const flagValue = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe("the one-job command", () => {
  it.each(TRACKS.flatMap((track) => TRACK_ARMS[track].map((arm) => [track, arm] as const)))("track %s arm %o pins model, effort, session and safe mode", (track, arm) => {
    const { args } = buildJobCommand(base({ arm, allowedTools: TRACK_TOOLS[track].allowed, deniedTools: TRACK_TOOLS[track].denied }));

    expect(flagValue(args, "--model")).toBe(arm.model);
    expect(flagValue(args, "--effort")).toBe(arm.effort);
    expect(flagValue(args, "--session-id")).toBe("00000000-0000-4000-8000-000000000001");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(flagValue(args, "--settings")).toBe("/work/bench-settings.json");
    const denied = args.slice(args.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining([...DENIED_TOOLS]));
  });

  it("starts from an empty environment with a job-local HOME and wraps only claude in a killing timeout", () => {
    const command = buildJobCommand(base());

    expect(command.file).toBe("env");
    expect(command.cwd).toBe("/work/job-1/ws");
    const claudeAt = command.args.indexOf("claude");
    expect(command.args.slice(0, claudeAt)).toEqual([
      "-i",
      "PATH=/work/bin",
      "HOME=/work/job-1/home",
      "XDG_CONFIG_HOME=/work/job-1/home/.config",
      "LANG=C.UTF-8",
      "CLAUDE_CONFIG_DIR=/profiles/bench",
      "NODE_OPTIONS=--max-old-space-size=4096",
      ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map((name) => `${name}=http://127.0.0.1:9`),
      ...["NO_PROXY", "no_proxy"].map((name) => `${name}=.anthropic.com,anthropic.com,.claude.ai,claude.ai,.claude.com,claude.com`),
      "timeout",
      "-k",
      "30",
      "900",
    ]);
    expect(command.args.slice(claudeAt + 1, claudeAt + 3)).toEqual(["-p", "Do the task."]);
  });

  it("appends the workspace CLAUDE.md only when the file exists", () => {
    const withFile = buildJobCommand(base({ appendSystemPromptFile: "/work/job-1/ws/CLAUDE.md" }), () => true);
    const withoutFile = buildJobCommand(base({ appendSystemPromptFile: "/work/job-1/ws/CLAUDE.md" }), () => false);

    expect(flagValue(withFile.args, "--append-system-prompt-file")).toBe("/work/job-1/ws/CLAUDE.md");
    expect(withoutFile.args).not.toContain("--append-system-prompt-file");
  });

  it("gives review and plan jobs read-only tools and implement jobs edit tools", () => {
    expect(TRACK_TOOLS.r.denied).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(TRACK_TOOLS.p.denied).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(TRACK_TOOLS.i.allowed).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    expect(TRACK_TOOLS.i.denied).not.toContain("Edit");
  });
});

describe("the run's settings file", () => {
  const options = { operatorHome: "/srv/operator/", jobsDir: "/runs/r1/jobs", osSandbox: false };

  it("repeats the flag deny list and denies Reads of operator state by absolute path", () => {
    const settings = benchSettings(TRACK_TOOLS.i.denied, options);

    expect(settings.permissions.deny).toEqual(expect.arrayContaining([...DENIED_TOOLS]));
    expect(settings.permissions.deny).toContain("Read(//srv/operator/.agent-chat/**)");
    expect(settings).not.toHaveProperty("sandbox");
  });

  it("with the OS sandbox, requires it and gives Bash no network and writes only in the run's job dirs", () => {
    const { sandbox } = benchSettings(TRACK_TOOLS.i.denied, { ...options, osSandbox: true });

    expect(sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { allowWrite: ["/runs/r1/jobs"] },
    });
  });
});

describe("TRACK_TOOLS", () => {
  it("does not allow rg on track r, which the bench hosts lack", () => {
    expect(TRACK_TOOLS.r.allowed).not.toContain("Bash(rg:*)");
  });
});
