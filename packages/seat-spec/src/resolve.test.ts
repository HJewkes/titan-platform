import { describe, expect, it } from "vitest";
import { deskSeat, HOME, json, stewardSeat } from "./fixtures.test-helpers.js";
import { parseSeat } from "./parse.js";
import { resolveLaunch } from "./resolve.js";
import type { SeatDefinition } from "./schema.js";

const parsed = (raw: Record<string, unknown>): SeatDefinition => {
  const result = parseSeat(json(raw), String(raw.name));
  if (!result.ok) throw new Error(result.refusal.detail);
  return result.seat;
};

const driftingRequest = {
  seat: "example-steward",
  profile: "example-worker",
  configDir: `${HOME}/.claude-profiles/example-other`,
  permissionMode: "default",
  surface: "headless",
  cwd: `${HOME}/projects/elsewhere`,
  depth: 3,
  remoteControl: false,
};

describe("resolveLaunch", () => {
  it("builds the launch from the definition, ignoring every posture field the requester chose", () => {
    const result = resolveLaunch(parsed(stewardSeat()), driftingRequest);

    expect(result).toMatchObject({
      ok: true,
      launch: {
        seat: "example-steward",
        seatVersion: 1,
        profile: "example-coordinator",
        configDir: `${HOME}/.claude-profiles/example-server`,
        permissionMode: "auto",
        surface: "tmux-window",
        cwd: `${HOME}/projects/example`,
        depth: 0,
        remoteControl: "example-steward",
      },
    });
  });

  it("lists each field it overrode so the broker can log the drift", () => {
    const result = resolveLaunch(parsed(stewardSeat()), driftingRequest);

    expect(result.ok && [...result.overridden].sort()).toEqual(
      ["configDir", "cwd", "depth", "permissionMode", "profile", "remoteControl", "surface"].sort(),
    );
  });

  it("reports no override when the requester asked for nothing", () => {
    expect(resolveLaunch(parsed(stewardSeat()), { seat: "example-steward" })).toMatchObject({ ok: true, overridden: [] });
  });

  it("gives a non-root seat depth 1 whatever depth the requester has", () => {
    const result = resolveLaunch(parsed(deskSeat()), { seat: "example-desk", depth: 3 });

    expect(result).toMatchObject({ ok: true, launch: { depth: 1, ceiling: [], ownerOnlyRead: true } });
  });

  it("carries the seat's tool rules and pinned prompt into the launch", () => {
    const result = resolveLaunch(parsed(deskSeat()), { seat: "example-desk" });

    expect(result).toMatchObject({
      ok: true,
      launch: { deny: expect.arrayContaining(["WebFetch"]), prompt: { path: "example-desk.prompt.md" } },
    });
  });

  it("passes no Remote Control name when the seat turns it off", () => {
    const result = resolveLaunch(parsed({ ...stewardSeat(), remoteControl: false }), { seat: "example-steward" });

    expect(result).toMatchObject({ ok: true, launch: { remoteControl: undefined } });
  });

  it("refuses a launch aimed at another seat", () => {
    const result = resolveLaunch(parsed(stewardSeat()), { seat: "example-desk" });

    expect(result).toMatchObject({ ok: false, refusal: { code: "name_mismatch" } });
  });
});
