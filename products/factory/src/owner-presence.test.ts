import { describe, expect, it } from "vitest";
import { confirmOwner, defaultHelperPath, type HelperRunner } from "./owner-presence.js";

const helperPath = "/synthetic/owner-presence";
const PROOF = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";

describe("confirmOwner", () => {
  it("returns the proof the helper prints on success", async () => {
    const run: HelperRunner = async () => `${PROOF}\n`;
    expect(await confirmOwner("resolve gate", { run, helperPath })).toBe(PROOF);
  });

  it.each([["a word", "proof-1234"], ["an uppercase UUID", PROOF.toUpperCase()], ["a UUID and more", `${PROOF} ok`], ["a non-v4 UUID", PROOF.replace("-4c3a-", "-1c3a-")]])(
    "refuses %s as a proof",
    async (_name, printed) => {
      const run: HelperRunner = async () => `${printed}\n`;
      expect(await confirmOwner("resolve gate", { run, helperPath })).toBeUndefined();
    },
  );

  it("runs the helper from native/build beside this package, whatever the environment says", async () => {
    const files: string[] = [];
    const run: HelperRunner = async (file) => (files.push(file), PROOF);
    process.env.OWNER_PRESENCE_HELPER = "/synthetic/stub";
    try {
      await confirmOwner("resolve gate", { run });
    } finally {
      delete process.env.OWNER_PRESENCE_HELPER;
    }
    expect(files).toEqual([defaultHelperPath()]);
    expect(defaultHelperPath()).toMatch(/products\/factory\/native\/build\/owner-presence$/);
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
      return PROOF;
    };
    await confirmOwner("approve\x1b[2J‮ and\\more", { run, helperPath });
    expect(seen).toEqual([["approve\\x1b[2J\\u202E and\\\\more"]]);
  });
});
