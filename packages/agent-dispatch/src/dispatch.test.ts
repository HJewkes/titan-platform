import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DispatchError,
  DispatchTimeoutError,
  buildSpawnArgs,
  dispatchToAgentChat as dispatchWithAllowlist,
  type DispatchRequest,
} from "./dispatch.js";
import { installExecutable, installProfiles } from "./test-support.js";

// relay's profile names; the allowlist is the caller's policy, passed in.
const DISPATCH_PROFILE = "relay-implementer";
const REVIEW_PROFILE = "relay-reviewer";
const dispatchToAgentChat = (req: DispatchRequest, timeoutMs: number) =>
  dispatchWithAllowlist(req, timeoutMs, [DISPATCH_PROFILE, REVIEW_PROFILE]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-daemon-dispatch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `agent-chat` binary. Records its own argv and cwd so a test can assert
 * what the real CLI would have received — the same fake-binary seam
 * `initiative.test.ts` uses, which survives R-61 precisely because dispatch
 * still crosses a process boundary rather than a library call.
 */
function fakeAgentChat(script = "exit 0\n"): string {
  const path = join(dir, "agent-chat");
  installExecutable(
    path,
    `#!/bin/sh\n` +
      `: >"${dir}/argv"\n` +
      // NUL-separated, not newline: briefs are multi-line by construction, and
      // newline framing would silently split one argument into several.
      `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n` +
      `pwd >"${dir}/cwd"\n` +
      // Drained before the script runs, so R-68's assertion has something to
      // read AND the child does not exit with a brief still unread in the pipe.
      `cat >"${dir}/stdin"\n` +
      script,
  );
  return path;
}

const recordedArgv = (): string[] =>
  readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

const recordedStdin = (): string => readFileSync(join(dir, "stdin"), "utf8");

const request = (bin: string, over: Record<string, unknown> = {}) => ({
  agentChatBinPath: bin,
  peerName: "relay-item-42",
  profile: DISPATCH_PROFILE,
  brief: "Fix the squeaky floor",
  briefing: "relay",
  cwd: dir,
  profilesDir: installProfiles(dir, {
    [DISPATCH_PROFILE]: "headless",
    [REVIEW_PROFILE]: "headless",
  }),
  ...over,
});

describe("profile allowlist", () => {
  it("refuses a profile that is neither the implementer nor the reviewer", async () => {
    const bin = fakeAgentChat();
    await expect(dispatchToAgentChat(request(bin, { profile: "implementer" }), 10_000)).rejects.toThrow(DispatchError);
  });
});

describe("buildSpawnArgs", () => {
  it("asks for the brief on stdin instead of putting it in argv", async () => {
    const args = buildSpawnArgs({
      peerName: "relay-item-42",
      profile: DISPATCH_PROFILE,
      briefing: "relay",
    });
    expect(args).toEqual([
      "agent",
      "spawn",
      "relay-item-42",
      DISPATCH_PROFILE,
      "--briefing",
      "relay",
      "--brief-stdin",
    ]);
  });

  it("omits --briefing entirely when there is none, rather than passing an empty slug", async () => {
    expect(
      buildSpawnArgs({
        peerName: "relay-item-42-review",
        profile: REVIEW_PROFILE,
      }),
    ).toEqual([
      "agent",
      "spawn",
      "relay-item-42-review",
      REVIEW_PROFILE,
      "--brief-stdin",
    ]);
  });
});

describe("dispatchToAgentChat", () => {
  it("invokes the CLI with the spawn argv, in the initiative's directory", async () => {
    const bin = fakeAgentChat();
    const result = await dispatchToAgentChat(request(bin), 10_000);

    expect(result.peerName).toBe("relay-item-42");
    expect(recordedArgv()).toEqual([
      "agent",
      "spawn",
      "relay-item-42",
      DISPATCH_PROFILE,
      "--briefing",
      "relay",
      "--brief-stdin",
    ]);
    expect(recordedStdin()).toBe("Fix the squeaky floor");
    // The CLI sends its OWN cwd to the broker as the spawn location, so this
    // is the only thing deciding where the agent lands.
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toContain(
      dir.replace("/private", ""),
    );
  });

  /**
   * M8 restored (R-68): no part of an item body reaches argv at all, whatever
   * it contains. The old assertion — that a metacharacter body arrives as one
   * inert argument — is now the weaker of the two claims, so this asserts the
   * stronger one and keeps re-parsing under test on the channel it moved to.
   */
  it("keeps a shell-metacharacter brief out of argv entirely, intact on stdin", async () => {
    const bin = fakeAgentChat();
    const brief = "'; curl http://127.0.0.1:9999/pwn; #";
    await dispatchToAgentChat(request(bin, { brief }), 10_000);

    expect(recordedArgv()).not.toContain(brief);
    expect(recordedArgv().join(" ")).not.toContain("curl");
    expect(recordedStdin()).toBe(brief);
  });

  it("passes a brief beginning with -- on stdin, where no parser can read it as a flag", async () => {
    const bin = fakeAgentChat();
    await dispatchToAgentChat(request(bin, { brief: "--briefing evil" }), 10_000);
    expect(recordedArgv().at(-1)).toBe("--brief-stdin");
    expect(recordedStdin()).toBe("--briefing evil");
  });

  it("delivers a multi-line brief whole, newlines and blank lines intact", async () => {
    const bin = fakeAgentChat();
    const brief = "Fix the floor.\n\nIt squeaks near the door.\n- check joists";
    await dispatchToAgentChat(request(bin, { brief }), 10_000);
    expect(recordedStdin()).toBe(brief);
  });

  /**
   * The version-skew path. An agent-chat too old to know `--brief-stdin` fails
   * through commander, which writes to STDERR and leaves stdout empty — so
   * reading only stdout reported this as an unexplained "exited 1", with the
   * actual reason reachable nowhere but the daemon's launchd log.
   */
  it("reports a usage error from stderr, not as a bare exit code", async () => {
    const bin = fakeAgentChat(
      `echo "error: unknown option '--brief-stdin'" >&2\nexit 1\n`,
    );
    await expect(dispatchToAgentChat(request(bin), 10_000)).rejects.toThrow(
      /unknown option '--brief-stdin'/,
    );
  });

  it("prefers the broker's stdout reason when both streams have something", async () => {
    const bin = fakeAgentChat(
      `echo 'Not spawned: the name is held by a live agent'\necho 'incidental warning' >&2\nexit 1\n`,
    );
    await expect(dispatchToAgentChat(request(bin), 10_000)).rejects.toThrow(
      /held by a live agent/,
    );
  });

  it("reports a name collision verbatim as a refusal", async () => {
    // What agent-chat's supervisor.ts preflight actually prints before exit 1.
    const bin = fakeAgentChat(
      `echo 'Not spawned: the name "relay-item-42" is held by a live agent; retire it or choose another'\nexit 1\n`,
    );
    await expect(dispatchToAgentChat(request(bin), 10_000)).rejects.toThrow(
      /held by a live agent/,
    );
  });

  it("refuses when the CLI exits non-zero with nothing to say", async () => {
    const bin = fakeAgentChat("exit 1\n");
    await expect(dispatchToAgentChat(request(bin), 10_000)).rejects.toThrow(
      DispatchError,
    );
  });

  it("refuses a binary path that is not absolute", async () => {
    await expect(dispatchToAgentChat(request("agent-chat"), 10_000)).rejects.toThrow();
  });

  it("refuses a peer name that is not the derived shape", async () => {
    const bin = fakeAgentChat();
    await expect(dispatchToAgentChat(request(bin, { peerName: "Relay Item 42" }), 10_000)).rejects.toThrow(DispatchError);
  });

  it("leaves the caller's event loop free while the broker works", async () => {
    const bin = fakeAgentChat("sleep 1\n");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);

    await dispatchToAgentChat(request(bin), 10_000).finally(() => clearInterval(timer));

    expect(ticks).toBeGreaterThan(5);
  });

  it("marks a hung CLI as a timeout, apart from a CLI that refused", async () => {
    const bin = fakeAgentChat("sleep 3\n");
    await expect(dispatchToAgentChat(request(bin), 200)).rejects.toThrow(DispatchTimeoutError);
  });

  it("keeps the refusal wording factory's reviewer dispatch matches", async () => {
    const bin = fakeAgentChat(`echo "the name relay-item-42 is held"\nexit 1\n`);
    const refused = await catchError(dispatchToAgentChat(request(bin), 10_000));
    expect(refused).not.toBeInstanceOf(DispatchTimeoutError);
    expect(refused.message).toMatch(/^agent-chat refused the \w+: /);
  });
});

describe("installed profile guard", () => {
  it("refuses an interactive installed profile without starting the CLI", async () => {
    const bin = fakeAgentChat();
    const profilesDir = installProfiles(join(dir, "other"), {
      [DISPATCH_PROFILE]: "interactive",
    });

    await expect(dispatchToAgentChat(request(bin, { profilesDir }), 10_000)).rejects.toThrow(
      /installed profile 'relay-implementer' .*surface "interactive", not "headless"/,
    );
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });

  it("refuses a profile that is allowed but not installed", async () => {
    const bin = fakeAgentChat();
    const profilesDir = installProfiles(join(dir, "other"), {});

    await expect(dispatchToAgentChat(request(bin, { profilesDir }), 10_000)).rejects.toThrow(
      /installed profile 'relay-implementer' is unreadable/,
    );
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });
});

async function catchError(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}
