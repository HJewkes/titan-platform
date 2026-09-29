import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectivePolicy } from "./policy.js";
import { loadSeatBook, lookupSeat } from "./seats.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-seats-"));
  dirs.push(dir);
  return dir;
}

function writeCharterBody(body: string): string {
  const path = join(scratch(), "charter.md");
  writeFileSync(path, body);
  return path;
}

function writeCharter(fields: string): string {
  return writeCharterBody(`---\nschema: autonomy-charter/v1\n${fields}---\n`);
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
    const book = loadSeatBook({ seatsDir: join(scratch(), "absent") });

    const lookup = lookupSeat(book, "acme/gadgets");

    expect(lookup).toEqual({ kind: "none" });
    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "owner-gate", fixer: false, seat: "none" });
  });

  it("matches a repo on its remote, case-insensitively", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT, "sprocket.md": SPROCKET_SEAT }) });

    expect(lookupSeat(book, "Acme/Sprockets")).toMatchObject({ kind: "seat", seat: { name: "sprocket-seat", grants: [] } });
  });

  it("gives a remote two seats list the narrowest default across them, whatever the file order", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "b-sprocket.md": SPROCKET_SEAT, "a-gadget.md": GADGET_SEAT }) });

    const lookup = lookupSeat(book, "acme/shared-kit");

    expect(lookup).toMatchObject({ kind: "seat", seat: { grants: [] } });
    expect(resolveEffectivePolicy(lookup).merge).toBe("owner-gate");
  });

  it("refuses a remote one seat lists when another seat denies it", () => {
    const denier = SPROCKET_SEAT.replace("grants_extra: []", "deny_repos: [~/src/shared-kit]\ngrants_extra: []");
    const book = loadSeatBook({ seatsDir: writeSeats({ "a-gadget.md": GADGET_SEAT, "b-sprocket.md": denier }) });

    expect(lookupSeat(book, "acme/shared-kit").kind).toBe("denied");
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

  it("denies a configured hard-stop repo only when the charter carries that hard stop", () => {
    const charter = writeCharter("hard_stops:\n  - dotfiles-merge   # merging dotfiles\n");
    const hardStopRepos = { "dotfiles-merge": ["acme/dotfiles"] };

    expect(lookupSeat(loadSeatBook({ charterPath: charter, hardStopRepos }), "Acme/Dotfiles").kind).toBe("denied");
    expect(lookupSeat(loadSeatBook({ charterPath: writeCharter("hard_stops: []\n"), hardStopRepos }), "acme/dotfiles").kind).toBe("none");
    expect(lookupSeat(loadSeatBook({ charterPath: charter }), "acme/dotfiles").kind).toBe("none");
  });

  it("ignores files without the .md extension", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.txt": "not a seat" }) });

    expect(book.seats).toEqual([]);
  });

  it.each([
    ["no frontmatter", "# notes\n"],
    ["another schema", "---\nschema: other/v1\nname: x\n---\n"],
    ["repos that is not a list", GADGET_SEAT.replace(/repos:\n(  - .*\n)+/, "repos: x\n")],
    ["unparseable yaml", "---\nschema: [\n---\n"],
  ])("throws, naming the file, when a seat file has %s", (_case, body) => {
    const seatsDir = writeSeats({ "a-good.md": GADGET_SEAT, "z-bad.md": body });

    expect(() => loadSeatBook({ seatsDir })).toThrow(/z-bad\.md/);
  });

  it.each([
    ["is missing", () => join(scratch(), "absent.md")],
    ["has no frontmatter", () => writeCharterBody("# charter\n")],
    ["has a hard_stops that is not a list", () => writeCharter("hard_stops: dotfiles-merge\n")],
    ["has a hard_stops with a non-string entry", () => writeCharter("hard_stops: [dotfiles-merge, 3]\n")],
  ])("throws when the configured charter %s", (_case, charterPath) => {
    expect(() => loadSeatBook({ charterPath: charterPath() })).toThrow(/charter/);
  });
});

describe("lookupSeat repo keys", () => {
  const book = () => loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT }) });

  it.each([
    ["a .git suffix", "acme/gadgets.git"],
    ["an https URL", "https://github.com/acme/gadgets"],
    ["an ssh URL", "git@github.com:acme/gadgets"],
    ["an extra slash", "acme/gadgets/extra"],
    ["a trailing slash", "acme/gadgets/"],
    ["a space", "acme/gadgets "],
    ["no owner", "gadgets"],
    ["an empty string", ""],
  ])("refuses a repo key with %s before lookup", (_case, repo) => {
    expect(lookupSeat(book(), repo)).toMatchObject({ kind: "denied", reason: expect.stringMatching(/owner\/name/) });
  });

  it("refuses the .git form of a denied repo instead of resolving it", () => {
    expect(lookupSeat(book(), "acme/parked-app.git").kind).toBe("denied");
  });
});
