import { describe, expect, it } from "vitest";
import { confirmOwner, type HelperRunner } from "./owner-presence.js";

const helperPath = "/synthetic/owner-presence";

describe("confirmOwner", () => {
  it("returns the proof the helper prints on success", async () => {
    const run: HelperRunner = async () => "proof-1234\n";
    expect(await confirmOwner("resolve gate", { run, helperPath })).toBe("proof-1234");
  });

  it("returns undefined when the owner cancels", async () => {
    const run: HelperRunner = async () => {
      throw Object.assign(new Error("Command failed"), { code: 1 });
    };
    expect(await confirmOwner("resolve gate", { run, helperPath })).toBeUndefined();
  });

  it("returns undefined when the helper is missing", async () => {
    const run: HelperRunner = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    expect(await confirmOwner("resolve gate", { run, helperPath })).toBeUndefined();
  });

  it("returns undefined when the helper succeeds but prints no proof", async () => {
    const run: HelperRunner = async () => "\n";
    expect(await confirmOwner("resolve gate", { run, helperPath })).toBeUndefined();
  });

  it("escapes control characters in the reason", async () => {
    const seen: string[][] = [];
    const run: HelperRunner = async (_file, args) => {
      seen.push([...args]);
      return "proof";
    };
    await confirmOwner("approve\x1b[2J‮ and\\more", { run, helperPath });
    expect(seen).toEqual([["approve\\x1b[2J\\u202E and\\\\more"]]);
  });
});
