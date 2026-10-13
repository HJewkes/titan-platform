import { describe, expect, it } from "vitest";
import { systemdListenFd } from "./systemd-socket.js";

const PID = 4242;

describe("systemdListenFd", () => {
  it("returns undefined when systemd passed nothing", () => {
    const env: NodeJS.ProcessEnv = { TERM: "dumb" };

    expect(systemdListenFd(env, PID)).toBeUndefined();
    expect(env).toEqual({ TERM: "dumb" });
  });

  it("leaves a socket meant for another process alone", () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: "1111", LISTEN_FDS: "1", LISTEN_FDNAMES: "titan-factory.socket" };

    expect(systemdListenFd(env, PID)).toBeUndefined();
    expect(env).toEqual({ LISTEN_PID: "1111", LISTEN_FDS: "1", LISTEN_FDNAMES: "titan-factory.socket" });
  });

  it("returns fd 3 for this process and removes the variables so no child inherits them", () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: String(PID), LISTEN_FDS: "1", LISTEN_FDNAMES: "titan-factory.socket", TERM: "dumb" };

    expect(systemdListenFd(env, PID)).toBe(3);
    expect(env).toEqual({ TERM: "dumb" });
  });

  it("refuses more than one socket", () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: String(PID), LISTEN_FDS: "2" };

    expect(() => systemdListenFd(env, PID)).toThrow("expected exactly one socket from systemd, got 2");
  });

  it("refuses a matching pid that names no socket count", () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: String(PID) };

    expect(() => systemdListenFd(env, PID)).toThrow("got 0");
  });
});
