import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import type * as clackPrompts from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepPaths } from "./steps-deps.js";
import { getSupervisor } from "./supervision.js";
import { runUninstall } from "./uninstall.js";

vi.mock("./supervision.js", () => ({ getSupervisor: vi.fn() }));

const SKILL_PROMPT = "Remove the active-work skill from ~/.claude/skills/?";
const COMMAND_PROMPT =
  "Remove the /aw-prompt command from ~/.claude/commands/?";
const SUPERVISION_PROMPT = "Remove the synthetic supervisor unit?";
const DAEMON_PROMPT = "Stop the daemon?";
const MCP_PROMPT = "Unregister MCP from Claude Code?";

const PATHS: StepPaths = {
  activeRoot: "/synthetic/active",
  stateRoot: "/synthetic/state",
  configRoot: "/synthetic/config",
  homeDir: "/synthetic/home",
};

function enoent(): Error {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function fakeFs(present: boolean): typeof fsp {
  return {
    stat: vi.fn(async () => {
      if (!present) throw enoent();
      return {};
    }),
    rm: vi.fn(async () => undefined),
  } as unknown as typeof fsp;
}

function fakeSpawn(code: number): typeof nodeSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", code));
    return child;
  }) as unknown as typeof nodeSpawn;
}

/** Answers each confirm prompt by its message; anything unlisted is a yes. */
function scriptedPrompts(answers: Record<string, boolean | symbol>) {
  const asked: Array<{ message: string; initialValue: boolean | undefined }> =
    [];
  const cancelled = Symbol("cancel");
  const prompts = {
    confirm: vi.fn(
      async (opts: { message: string; initialValue?: boolean }) => {
        asked.push({ message: opts.message, initialValue: opts.initialValue });
        const answer = answers[opts.message];
        return answer === "cancel" ? cancelled : answer ?? true;
      }
    ),
    isCancel: (value: unknown) => value === cancelled,
  } as unknown as typeof clackPrompts;
  return { prompts, asked };
}

const supervisorUninstall = vi.fn();

beforeEach(() => {
  supervisorUninstall.mockReset();
  supervisorUninstall.mockResolvedValue({
    ok: true,
    name: "install-supervision",
    done: true,
    message: "Removed synthetic unit",
  });
  vi.mocked(getSupervisor).mockReturnValue({
    uninstallPrompt: SUPERVISION_PROMPT,
    uninstall: supervisorUninstall,
  } as unknown as ReturnType<typeof getSupervisor>);
});

describe("runUninstall", () => {
  it("runs every step without prompting when yes is set", async () => {
    const { prompts, asked } = scriptedPrompts({});

    const report = await runUninstall({
      prompts,
      yes: true,
      paths: PATHS,
      fs: fakeFs(true),
      spawn: fakeSpawn(0),
    });

    expect(asked).toEqual([]);
    expect(report.activeRootPreservedAt).toBe(PATHS.activeRoot);
    expect(report.steps).toEqual([
      {
        name: "install-skill",
        done: true,
        message: expect.stringContaining("Removed skill"),
      },
      {
        name: "install-command",
        done: true,
        message: expect.stringContaining("Removed /aw-prompt"),
      },
      {
        name: "install-supervision",
        done: true,
        message: "Removed synthetic unit",
      },
      { name: "start-daemon", done: true, message: "Daemon stopped" },
      {
        name: "register-mcp",
        done: true,
        message: "Unregistered MCP server from Claude Code",
      },
    ]);
  });

  it("asks the prompts in order, each defaulting to yes", async () => {
    const { prompts, asked } = scriptedPrompts({});

    await runUninstall({
      prompts,
      paths: PATHS,
      fs: fakeFs(true),
      spawn: fakeSpawn(0),
    });

    expect(asked).toEqual(
      [
        SKILL_PROMPT,
        COMMAND_PROMPT,
        SUPERVISION_PROMPT,
        DAEMON_PROMPT,
        MCP_PROMPT,
      ].map((message) => ({ message, initialValue: true }))
    );
  });

  it.each([
    ["install-skill", SKILL_PROMPT],
    ["install-command", COMMAND_PROMPT],
    ["install-supervision", SUPERVISION_PROMPT],
    ["start-daemon", DAEMON_PROMPT],
    ["register-mcp", MCP_PROMPT],
  ])(
    "skips only the %s step when that prompt is declined",
    async (name, prompt) => {
      const { prompts } = scriptedPrompts({ [prompt]: false });
      const fs = fakeFs(true);

      const report = await runUninstall({
        prompts,
        paths: PATHS,
        fs,
        spawn: fakeSpawn(0),
      });

      expect(report.steps.map((s) => s.name)).toEqual([
        "install-skill",
        "install-command",
        "install-supervision",
        "start-daemon",
        "register-mcp",
      ]);
      for (const step of report.steps) {
        if (step.name === name)
          expect(step).toEqual({ name, done: false, message: "Skipped" });
        else expect(step.done).toBe(true);
      }
      if (name === "install-supervision")
        expect(supervisorUninstall).not.toHaveBeenCalled();
    }
  );

  it("treats a cancelled prompt as a skip", async () => {
    const { prompts } = scriptedPrompts({
      [DAEMON_PROMPT]: "cancel" as unknown as symbol,
    });

    const report = await runUninstall({
      prompts,
      paths: PATHS,
      fs: fakeFs(true),
      spawn: fakeSpawn(0),
    });

    expect(report.steps.find((s) => s.name === "start-daemon")).toEqual({
      name: "start-daemon",
      done: false,
      message: "Skipped",
    });
  });

  it("omits the supervision step and prompt when the platform has no supervisor", async () => {
    vi.mocked(getSupervisor).mockReturnValue(null);
    const { prompts, asked } = scriptedPrompts({});

    const report = await runUninstall({
      prompts,
      paths: PATHS,
      fs: fakeFs(true),
      spawn: fakeSpawn(0),
    });

    expect(asked.map((a) => a.message)).toEqual([
      SKILL_PROMPT,
      COMMAND_PROMPT,
      DAEMON_PROMPT,
      MCP_PROMPT,
    ]);
    expect(report.steps.map((s) => s.name)).toEqual([
      "install-skill",
      "install-command",
      "start-daemon",
      "register-mcp",
    ]);
  });

  it("reports a not-present skill and a failing daemon stop without error fields", async () => {
    const { prompts } = scriptedPrompts({});

    const report = await runUninstall({
      prompts,
      paths: PATHS,
      fs: fakeFs(false),
      spawn: fakeSpawn(3),
    });

    expect(report.steps[0]).toEqual({
      name: "install-skill",
      done: false,
      message:
        "Skill not present at /synthetic/home/.claude/skills/active-work",
    });
    expect(report.steps[3]).toEqual({
      name: "start-daemon",
      done: false,
      message: "Daemon stop exited 3",
    });
  });

  it("carries a failed step as an error and no message", async () => {
    supervisorUninstall.mockResolvedValue({
      ok: false,
      name: "install-supervision",
      error: "boom",
    });
    const { prompts } = scriptedPrompts({});

    const report = await runUninstall({
      prompts,
      paths: PATHS,
      fs: fakeFs(true),
      spawn: fakeSpawn(0),
    });

    expect(report.steps[2]).toEqual({
      name: "install-supervision",
      done: false,
      error: "boom",
    });
  });
});
