import { describe, expect, it } from "vitest";
import { findDrift, pinUnpinned } from "./migration-drift.mjs";

const hashOf = (m) => (m.definition === undefined ? null : `h:${m.definition}`);
const shipped = { version: 1, name: "create t", definition: "CREATE TABLE t (a)" };

describe("migration drift check", () => {
  it("fails when a pinned migration's definition was edited", () => {
    const result = findDrift({ main: { 1: "h:CREATE TABLE t (a)" } }, { main: [{ ...shipped, definition: "CREATE TABLE t (a, b)" }] }, hashOf);

    expect(result.edited).toEqual(["main version 1: pinned h:CREATE TABLE t (a), now h:CREATE TABLE t (a, b)"]);
  });

  it("passes an unchanged pinned migration", () => {
    expect(findDrift({ main: { 1: "h:CREATE TABLE t (a)" } }, { main: [shipped] }, hashOf)).toEqual({ edited: [], unpinned: [] });
  });

  it("skips a migration that declares no definition", () => {
    expect(findDrift({}, { main: [{ version: 1, name: "bare" }] }, hashOf)).toEqual({ edited: [], unpinned: [] });
  });

  it("reports a defined migration nobody pinned, and pinning never rewrites a pinned hash", () => {
    const { unpinned } = findDrift({ main: { 1: "old" } }, { main: [shipped, { version: 2, definition: "x" }] }, hashOf);

    expect(unpinned).toEqual([{ id: "main", version: 2, hash: "h:x" }]);
    expect(pinUnpinned({ main: { 1: "old" } }, unpinned)).toEqual({ main: { 1: "old", 2: "h:x" } });
  });
});
