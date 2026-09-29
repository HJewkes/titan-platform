import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectivePolicy } from "./policy.js";
import { DOTFILES_REMOTE, loadSeatBook, lookupSeat } from "./seats.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-seats-"));
  dirs.push(dir);
  return dir;
}

function writeSeats(files: Record<string, string>): string {
  const dir = join(scratch(), "seats");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const GADGET_SEAT = `---
schema: autonomy-seat/v1
name: gadget-seat
repos:
  - {path: ~/src/gadgets, remote: acme/gadgets, default: main}
  - {path: ~/src/shared-kit, remote: acme/shared-kit}
  - {path: ~/src/local-only}
deny_repos: [~/src/parked-app, ~/src/gadgets-legacy]
grants_extra: [merge-on-green-approve]
---
# Gadget seat

Prose below the frontmatter is ignored.
`;

const SPROCKET_SEAT = `---
schema: autonomy-seat/v1
name: sprocket-seat
repos:
  - {path: ~/src/sprockets, remote: acme/sprockets}
  - {path: ~/src/shared-kit, remote: acme/shared-kit}
  - {path: ~/src/gadgets-legacy, remote: acme/old-gadgets}
grants_extra: []
---
`;

describe("loadSeatBook", () => {
  it("resolves a repo to owner-gate with no fixer when the seats directory is missing", () => {
    const book = loadSeatBook({ seatsDir: join(scratch(), "absent"), charterPath: join(scratch(), "absent.md") });

    const lookup = lookupSeat(book, "acme/gadgets");

    expect(lookup).toEqual({ kind: "none" });
    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "owner-gate", fixer: false, seat: "none" });
  });

  it("matches a repo on its remote, case-insensitively", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT, "sprocket.md": SPROCKET_SEAT }) });

    expect(lookupSeat(book, "Acme/Sprockets")).toMatchObject({ kind: "seat", seat: { name: "sprocket-seat", grants: [] } });
  });

  it("gives a remote two seats list to the first seat file by name", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "b-sprocket.md": SPROCKET_SEAT, "a-gadget.md": GADGET_SEAT }) });

    expect(lookupSeat(book, "acme/shared-kit")).toMatchObject({ kind: "seat", seat: { name: "gadget-seat" } });
  });

  it("denies a deny_repos path by its basename when the seat lists no remote for it", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT }) });

    expect(lookupSeat(book, "acme/parked-app").kind).toBe("denied");
    expect(lookupSeat(book, "acme/gadgets").kind).toBe("seat");
  });

  it("maps a deny_repos path to a remote only through the same seat's repos", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT, "sprocket.md": SPROCKET_SEAT }) });

    expect(lookupSeat(book, "acme/gadgets-legacy").kind).toBe("denied");
    expect(lookupSeat(book, "acme/old-gadgets")).toMatchObject({ kind: "seat", seat: { name: "sprocket-seat" } });
  });

  it("denies the dotfiles repo only when the charter carries the dotfiles-merge hard stop", () => {
    const charter = join(scratch(), "charter.md");
    writeFileSync(charter, "---\nschema: autonomy-charter/v1\nhard_stops:\n  - dotfiles-merge   # merging dotfiles\n---\n");

    expect(lookupSeat(loadSeatBook({ charterPath: charter }), DOTFILES_REMOTE).kind).toBe("denied");
    expect(lookupSeat(loadSeatBook({}), DOTFILES_REMOTE).kind).toBe("none");
  });

  it("skips files that are not autonomy-seat/v1", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "notes.md": "# no frontmatter\n", "other.md": "---\nschema: other/v1\nname: x\n---\n", "gadget.txt": GADGET_SEAT }) });

    expect(book.seats).toEqual([]);
  });
});
