import { describe, expect, it } from "vitest";
import { checkOwnerFile } from "./file-checks.js";
import { context, facts, HOME, SEATS_DIR } from "./fixtures.test-helpers.js";

const SEAT_FILE = `${SEATS_DIR}/example-steward.seat.json`;

describe("checkOwnerFile", () => {
  it("passes an owner-held 0644 regular file in the seats directory", () => {
    expect(checkOwnerFile(SEAT_FILE, facts(), context())).toBeUndefined();
  });

  it("passes a seats directory given with a trailing slash", () => {
    expect(checkOwnerFile(SEAT_FILE, facts(), context({ seatsDir: `${SEATS_DIR}/` }))).toBeUndefined();
  });

  it.each([
    ["a symlink", facts({ kind: "symlink" }), "symlink"],
    ["a directory", facts({ kind: "dir" }), "not_regular_file"],
    ["another uid's file", facts({ uid: 1001 }), "wrong_owner"],
    ["a group-writable file", facts({ mode: 0o100664 }), "writable_by_others"],
    ["a world-writable file", facts({ mode: 0o100646 }), "writable_by_others"],
  ])("refuses %s", (_label, fileFacts, code) => {
    expect(checkOwnerFile(SEAT_FILE, fileFacts, context())).toMatchObject({ code });
  });

  it.each([
    ["in a subdirectory", `${SEATS_DIR}/nested/example-steward.seat.json`],
    ["beside the seats directory", `${HOME}/.agent-chat/example-steward.seat.json`],
    ["a relative path", "seats/example-steward.seat.json"],
    ["a path that climbs out", `${SEATS_DIR}/../example-steward.seat.json`],
  ])("refuses a file %s", (_label, filePath) => {
    expect(checkOwnerFile(filePath, facts(), context())).toMatchObject({ code: "outside_seats_dir" });
  });

  it("refuses a seats directory under an agent-writable root", () => {
    const ctx = context({ agentWritableRoots: [`${HOME}/.agent-chat`] });

    expect(checkOwnerFile(SEAT_FILE, facts(), ctx)).toMatchObject({ code: "agent_writable_path" });
  });

  it("refuses an agent-writable root inside the seats directory", () => {
    const ctx = context({ agentWritableRoots: [`${SEATS_DIR}/scratch`] });

    expect(checkOwnerFile(SEAT_FILE, facts(), ctx)).toMatchObject({ code: "agent_writable_path" });
  });

  it("does not treat a sibling with a shared prefix as inside an agent root", () => {
    const ctx = context({ agentWritableRoots: [`${HOME}/.agent-chat/seats-scratch`] });

    expect(checkOwnerFile(SEAT_FILE, facts(), ctx)).toBeUndefined();
  });

  it.each([
    ["a symlinked", facts({ kind: "symlink" })],
    ["a group-writable", facts({ kind: "dir", mode: 0o40775 })],
    ["another uid's", facts({ kind: "dir", uid: 1001 })],
  ])("refuses %s seats directory", (_label, dirFacts) => {
    expect(checkOwnerFile(SEAT_FILE, facts(), context({ seatsDirFacts: dirFacts }))).toMatchObject({
      code: "seats_dir_unsafe",
    });
  });
});
