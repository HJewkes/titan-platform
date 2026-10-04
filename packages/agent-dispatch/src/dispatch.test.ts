import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DispatchError,
  buildSpawnArgs,
  dispatchToAgentChat as dispatchWithAllowlist,
  type DispatchRequest,
} from "./dispatch.js";
import { installExecutable } from "./test-support.js";

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
  ...over,
});

describe("profile allowlist", () => {
  it("refuses a profile that is neither the implementer nor the reviewer", () => {
    const bin = fakeAgentChat();
    expect(() =>
      dispatchToAgentChat(request(bin, { profile: "implementer" }), 10_000),
    ).toThrow(DispatchError);
  });
});

describe("buildSpawnArgs", () => {
  it("asks for the brief on stdin instead of putting it in argv", () => {
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

  it("omits --briefing entirely when there is none, rather than passing an empty slug", () => {
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
  it("invokes the CLI with the spawn argv, in the initiative's directory", () => {
    const bin = fakeAgentChat();
    const result = dispatchToAgentChat(request(bin), 10_000);

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
  it("keeps a shell-metacharacter brief out of argv entirely, intact on stdin", () => {
    const bin = fakeAgentChat();
    const brief = "'; curl http://127.0.0.1:9999/pwn; #";
    dispatchToAgentChat(request(bin, { brief }), 10_000);

    expect(recordedArgv()).not.toContain(brief);
    expect(recordedArgv().join(" ")).not.toContain("curl");
    expect(recordedStdin()).toBe(brief);
  });

  it("passes a brief beginning with -- on stdin, where no parser can read it as a flag", () => {
    const bin = fakeAgentChat();
    dispatchToAgentChat(request(bin, { brief: "--briefing evil" }), 10_000);
    expect(recordedArgv().at(-1)).toBe("--brief-stdin");
    expect(recordedStdin()).toBe("--briefing evil");
  });

  it("delivers a multi-line brief whole, newlines and blank lines intact", () => {
    const bin = fakeAgentChat();
    const brief = "Fix the floor.\n\nIt squeaks near the door.\n- check joists";
    dispatchToAgentChat(request(bin, { brief }), 10_000);
    expect(recordedStdin()).toBe(brief);
  });

  /**
   * The version-skew path. An agent-chat too old to know `--brief-stdin` fails
   * through commander, which writes to STDERR and leaves stdout empty — so
   * reading only stdout reported this as an unexplained "exited 1", with the
   * actual reason reachable nowhere but the daemon's launchd log.
   */
  it("reports a usage error from stderr, not as a bare exit code", () => {
    const bin = fakeAgentChat(
      `echo "error: unknown option '--brief-stdin'" >&2\nexit 1\n`,
    );
    expect(() => dispatchToAgentChat(request(bin), 10_000)).toThrow(
      /unknown option '--brief-stdin'/,
    );
  });

  it("prefers the broker's stdout reason when both streams have something", () => {
    const bin = fakeAgentChat(
      `echo 'Not spawned: the name is held by a live agent'\necho 'incidental warning' >&2\nexit 1\n`,
    );
    expect(() => dispatchToAgentChat(request(bin), 10_000)).toThrow(
      /held by a live agent/,
    );
  });

  it("reports a name collision verbatim as a refusal", () => {
    // What agent-chat's supervisor.ts preflight actually prints before exit 1.
    const bin = fakeAgentChat(
      `echo 'Not spawned: the name "relay-item-42" is held by a live agent; retire it or choose another'\nexit 1\n`,
    );
    expect(() => dispatchToAgentChat(request(bin), 10_000)).toThrow(
      /held by a live agent/,
    );
  });

  it("refuses when the CLI exits non-zero with nothing to say", () => {
    const bin = fakeAgentChat("exit 1\n");
    expect(() => dispatchToAgentChat(request(bin), 10_000)).toThrow(
      DispatchError,
    );
  });

  it("refuses a binary path that is not absolute", () => {
    expect(() => dispatchToAgentChat(request("agent-chat"), 10_000)).toThrow();
  });

  it("refuses a peer name that is not the derived shape", () => {
    const bin = fakeAgentChat();
    expect(() =>
      dispatchToAgentChat(request(bin, { peerName: "Relay Item 42" }), 10_000),
    ).toThrow(DispatchError);
  });

  it("turns a hung CLI into a refusal rather than hanging the loop", () => {
    const bin = fakeAgentChat("sleep 3\n");
    expect(() => dispatchToAgentChat(request(bin), 200)).toThrow(DispatchError);
  });
});
