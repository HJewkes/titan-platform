import { describe, expect, it } from "vitest";
import { editLauncher, unitNameOf, type LaunchIo } from "./edit-launch.js";

// Synthetic: invented edit ids and paths; nothing here starts a real process or unit.

function fakeIo(reachable: boolean, status: number | null = 0) {
  const ran: { command: string; args: readonly string[] }[] = [];
  const detached: { argv: readonly string[]; logFile: string }[] = [];
  const io: LaunchIo = {
    systemdReachable: () => reachable,
    run: (command, args) => (ran.push({ command, args }), status),
    detach: (argv, logFile) => void detached.push({ argv, logFile }),
    node: "/opt/node",
    bin: "/opt/explainer.js",
  };
  return { io, ran, detached };
}

const logFile = `${process.env.TMPDIR ?? "/tmp"}/explainer-launch-test/edits/e1.log`;

describe("edit launcher", () => {
  it("starts a transient user unit appending to the edit log when the user manager is reachable", () => {
    const { io, ran, detached } = fakeIo(true);

    editLauncher("edit-7", io)(["run", "--from", "resolve"], logFile);

    expect(ran).toEqual([
      {
        command: "systemd-run",
        args: ["--user", "--collect", "--quiet", "--unit", "explainer-run-edit-7", `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`, "--", "/opt/node", "/opt/explainer.js", "run", "--from", "resolve"],
      },
    ]);
    expect(detached).toEqual([]);
  });

  it("spawns detached when the user manager is not reachable", () => {
    const { io, ran, detached } = fakeIo(false);

    editLauncher("edit-7", io)(["run"], logFile);

    expect(ran).toEqual([]);
    expect(detached).toEqual([{ argv: ["run"], logFile }]);
  });

  it("falls back to a detached spawn when systemd-run refuses the unit", () => {
    const { io, detached } = fakeIo(true, 1);

    editLauncher("edit-7", io)(["run"], logFile);

    expect(detached).toEqual([{ argv: ["run"], logFile }]);
  });

  it("names a unit with only characters systemd accepts, one per edit", () => {
    const sanitised = unitNameOf("a/b c:d");

    expect(sanitised).toBe("explainer-run-a-b-c-d");
    expect(unitNameOf("edit-1")).not.toBe(unitNameOf("edit-2"));
  });
});
