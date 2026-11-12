import { describe, expect, it } from "vitest";
import { deskSeat, facts, indexJson, json, loadInput, SEATS_DIR, stewardSeat } from "./fixtures.test-helpers.js";
import { loadSeat } from "./load.js";

const refusalCode = (result: ReturnType<typeof loadSeat>) => (result.ok ? "ok" : result.refusal.code);

const deskIndex = (readers: string[]) => ({ path: `${SEATS_DIR}/index.json`, facts: facts(), content: indexJson(readers) });

describe("loadSeat", () => {
  it("loads a seat whose files, prompt hash and index all check out, with the file's hash", () => {
    const result = loadSeat(loadInput(stewardSeat()));

    expect(result).toMatchObject({ ok: true, seat: { name: "example-steward", version: 1 } });
    expect(result.ok && result.seatHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a prompt whose hash differs from the one the seat pins", () => {
    const result = loadSeat(loadInput(stewardSeat(), { prompt: { content: "# edited by a handoff\n" } }));

    expect(refusalCode(result)).toBe("prompt_hash_mismatch");
  });

  it("refuses an unreadable prompt file", () => {
    const result = loadSeat(loadInput(stewardSeat(), { prompt: { error: "ENOENT" } }));

    expect(refusalCode(result)).toBe("prompt_unreadable");
  });

  it("refuses a seat file that could not be read instead of treating it as no seat", () => {
    const input = loadInput(stewardSeat());
    const result = loadSeat({ ...input, seat: { path: input.seat.path, error: "EACCES" } });

    expect(result).toMatchObject({ ok: false, refusal: { code: "unreadable", detail: expect.stringContaining("EACCES") } });
  });

  it("refuses a seat file that fails the owner-file checks", () => {
    const input = loadInput(stewardSeat());
    const result = loadSeat({ ...input, seat: { ...input.seat, facts: facts({ mode: 0o100666 }) } });

    expect(refusalCode(result)).toBe("writable_by_others");
  });

  it("refuses when the index itself is unsafe", () => {
    const input = loadInput(stewardSeat());
    const result = loadSeat({ ...input, index: { ...input.index, facts: facts({ kind: "symlink" }) } });

    expect(refusalCode(result)).toBe("symlink");
  });

  it("refuses a seat file named for another seat", () => {
    const input = loadInput(stewardSeat());
    const result = loadSeat({ ...input, name: "example-other" });

    expect(refusalCode(result)).toBe("name_mismatch");
  });

  it("loads the desk when the index lists it as the owner-only reader", () => {
    const result = loadSeat(loadInput(deskSeat(), { index: deskIndex(["example-desk"]) }));

    expect(result).toMatchObject({ ok: true, seat: { ownerOnlyRead: true } });
  });

  it("refuses a second seat that sets ownerOnlyRead", () => {
    const second = { ...deskSeat(), name: "example-second-desk" };
    const result = loadSeat(loadInput(second, { index: deskIndex(["example-desk"]) }));

    expect(refusalCode(result)).toBe("owner_only_read_not_listed");
  });

  it("refuses an index that names two owner-only readers", () => {
    const result = loadSeat(loadInput(deskSeat(), { index: deskIndex(["example-desk", "example-steward"]) }));

    expect(refusalCode(result)).toBe("invalid_field");
  });

  it("hashes the exact bytes it was given", () => {
    const seat = json(stewardSeat());
    const input = loadInput(stewardSeat());
    const asText = loadSeat({ ...input, seat: { ...input.seat, content: seat } });
    const asBytes = loadSeat({ ...input, seat: { ...input.seat, content: new TextEncoder().encode(seat) } });

    expect(asText.ok && asBytes.ok && asText.seatHash === asBytes.seatHash).toBe(true);
  });
});
