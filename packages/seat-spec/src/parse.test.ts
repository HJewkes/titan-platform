import { describe, expect, it } from "vitest";
import { deskSeat, json, stewardSeat } from "./fixtures.test-helpers.js";
import { parseSeat, parseSeatIndex } from "./parse.js";

const codeOf = (seat: Record<string, unknown>, name = String(seat.name)) => {
  const result = parseSeat(json(seat), name);
  return result.ok ? "ok" : result.refusal;
};

describe("parseSeat", () => {
  it("accepts the steward and the personal desk sketches", () => {
    expect(codeOf(stewardSeat())).toBe("ok");
    expect(codeOf(deskSeat())).toBe("ok");
  });

  it("refuses a definition missing a required field, naming it", () => {
    const seat = stewardSeat();
    delete seat.configDir;

    expect(codeOf(seat)).toEqual({ code: "missing_field", detail: "configDir" });
  });

  it("refuses a missing nested field rather than defaulting it", () => {
    const seat = { ...stewardSeat(), wake: { cron: "0 9 * * 1" } };

    expect(codeOf(seat)).toEqual({ code: "missing_field", detail: "wake.owner" });
  });

  it("refuses an unknown top-level field, naming it", () => {
    expect(codeOf({ ...stewardSeat(), model: "example-model" })).toEqual({ code: "unknown_field", detail: "model" });
  });

  it("refuses an unknown nested field, naming its path", () => {
    const seat = { ...stewardSeat(), prompt: { path: "example-steward.prompt.md", sha256: "a".repeat(64), alt: "x" } };

    expect(codeOf(seat)).toEqual({ code: "unknown_field", detail: "prompt.alt" });
  });

  it.each(["bypassPermissions", "dontAsk"])("refuses the %s permission mode by name", (mode) => {
    const result = codeOf({ ...stewardSeat(), permissionMode: mode });

    expect(result).toMatchObject({ code: "bypass_permission_mode" });
  });

  it("refuses an unlisted permission mode as invalid", () => {
    expect(codeOf({ ...stewardSeat(), permissionMode: "yolo" })).toMatchObject({ code: "invalid_field" });
  });

  it("refuses a headless surface by name", () => {
    expect(codeOf({ ...stewardSeat(), surface: "headless" })).toMatchObject({ code: "headless_surface" });
  });

  it("refuses a definition whose name differs from its file name", () => {
    expect(codeOf(stewardSeat(), "example-other")).toMatchObject({ code: "name_mismatch" });
  });

  it("refuses another schema version", () => {
    expect(codeOf({ ...stewardSeat(), schema: "titan-seat/v2" })).toMatchObject({ code: "unknown_schema" });
  });

  it("refuses a relative config dir and a prompt path that leaves the seats directory", () => {
    expect(codeOf({ ...stewardSeat(), configDir: "~/.claude" })).toMatchObject({ code: "invalid_field" });
    const prompt = { path: "../example-steward.prompt.md", sha256: "a".repeat(64) };
    expect(codeOf({ ...stewardSeat(), prompt })).toMatchObject({ code: "invalid_field" });
  });

  it.each([
    ["cwd", "/home/example/./projects"],
    ["configDir", "/home/example//profiles"],
    ["cwd", "/home/example/projects/"],
  ])("refuses a %s that is not already clean (%s)", (field, value) => {
    expect(codeOf({ ...stewardSeat(), [field]: value })).toMatchObject({ code: "invalid_field" });
  });

  it.each([["cwd"], ["configDir"]])("refuses a %s with a control character", (field) => {
    expect(codeOf({ ...stewardSeat(), [field]: "/home/example/a\u0000b" })).toMatchObject({ code: "invalid_field" });
  });

  it("refuses a seat that allows more than one instance", () => {
    expect(codeOf({ ...stewardSeat(), singleInstance: false })).toMatchObject({ code: "invalid_field" });
  });

  it("refuses unparsable text and a non-object as refusals, not as no seat", () => {
    expect(parseSeat("{", "example-steward")).toMatchObject({ ok: false, refusal: { code: "malformed_json" } });
    expect(parseSeat("[]", "example-steward")).toMatchObject({ ok: false, refusal: { code: "not_an_object" } });
  });
});

describe("parseSeatIndex", () => {
  const index = (ownerOnlyReaders: string[]) =>
    parseSeatIndex(json({ schema: "titan-seat-index/v1", seats: ["example-desk"], ownerOnlyReaders }));

  it("accepts one owner-only reader", () => {
    expect(index(["example-desk"])).toMatchObject({ ok: true });
  });

  it("refuses an owner-only reader that is not a listed seat", () => {
    const result = parseSeatIndex(json({ schema: "titan-seat-index/v1", seats: ["example-steward"], ownerOnlyReaders: ["example-desk"] }));

    expect(result).toMatchObject({ ok: false, refusal: { code: "invalid_field", detail: expect.stringContaining("ownerOnlyReaders") } });
  });

  it("refuses a second owner-only reader", () => {
    expect(index(["example-desk", "example-steward"])).toMatchObject({ ok: false, refusal: { code: "invalid_field" } });
  });
});
