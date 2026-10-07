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

const NOT_ALLOWED = /not an allowed path/;

function seat(name: string, fields: string): string {
  return `---\nschema: autonomy-seat/v1\nname: ${name}\n${fields}---\n`;
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

    expect(lookup).toMatchObject({ kind: "seat", seat: { grants: [], paths: { "acme/shared-kit": "~/src/shared-kit" } } });
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

  it("resolves a deny_repos path through every seat's repos, not only its own", () => {
    const denier = seat("a-seat", "repos: []\ndeny_repos: [~/p/legacy]\n");
    const owner = seat("b-seat", "repos:\n  - {path: ~/p/legacy, remote: acme/renamed}\ngrants_extra: [merge-on-green-approve]\n");
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": denier, "b.md": owner }) });

    expect(lookupSeat(book, "acme/renamed").kind).toBe("denied");
  });

  it.each([
    ["a trailing slash on the deny", "~/p/park/", "~/p/park"],
    ["a trailing slash on the repo path", "~/p/park", "~/p/park//"],
    ["a doubled slash", "~/p//park", "~/p/park"],
  ])("matches a deny_repos path to a repo path despite %s", (_case, denyPath, repoPath) => {
    const denier = seat("a-seat", `repos: []\ndeny_repos: ["${denyPath}"]\n`);
    const owner = seat("b-seat", `repos:\n  - {path: "${repoPath}", remote: acme/park-renamed}\n`);
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": denier, "b.md": owner }) });

    expect(lookupSeat(book, "acme/park-renamed").kind).toBe("denied");
  });

  it.each([
    ["~/P/Legacy", "denied"],
    ["$HOME/p/legacy", "denied"],
    ["${HOME}/p/legacy", "denied"],
    ["/srv/seat-home/p/legacy", "denied"],
    ["/Srv/Seat-Home/p/legacy/", "denied"],
    ["~/p/legacy ", NOT_ALLOWED],
    ["~/p/l\u0435gacy", NOT_ALLOWED],
    ["/", NOT_ALLOWED],
    ["", NOT_ALLOWED],
    ["p/legacy", NOT_ALLOWED],
    ["~seat-home/p/legacy", NOT_ALLOWED],
    ["$USER/p/legacy", NOT_ALLOWED],
    ["/srv/$HOME/p/legacy", NOT_ALLOWED],
    ["%7E/p/legacy", NOT_ALLOWED],
    ["$home/p/legacy", NOT_ALLOWED],
    ["~", NOT_ALLOWED],
    ["~/", NOT_ALLOWED],
    ["~/p/leg@cy", NOT_ALLOWED],
  ] as const)("resolves the deny spelling %j to the bound remote or throws", (denyPath, expected) => {
    const denier = seat("a-seat", `repos: []\ndeny_repos: [${JSON.stringify(denyPath)}]\n`);
    const owner = seat("b-seat", "repos:\n  - {path: ~/p/legacy, remote: acme/renamed}\ngrants_extra: [merge-on-green-approve]\n");
    const load = () => loadSeatBook({ seatsDir: writeSeats({ "a.md": denier, "b.md": owner }), home: "/srv/seat-home" });

    if (expected === "denied") expect(lookupSeat(load(), "acme/renamed").kind).toBe("denied");
    else expect(load).toThrow(expected);
  });

  it("throws when the unbound deny path has no repo-name basename", () => {
    const seatsDir = writeSeats({ "a.md": seat("a-seat", "repos: []\ndeny_repos: [~/p/...]\n") });

    expect(() => loadSeatBook({ seatsDir })).toThrow(/a\.md.*not a repo name/);
  });

  it.each(["p/legacy", "./p/legacy", "~seat-home/p/legacy", "$USER/p/legacy"])("throws, naming the file, when a repo path is %j", (repoPath) => {
    const seatsDir = writeSeats({ "a.md": seat("a-seat", `repos:\n  - {path: ${JSON.stringify(repoPath)}, remote: acme/renamed}\n`) });

    expect(() => loadSeatBook({ seatsDir })).toThrow(/a\.md.*not an allowed path/);
  });

  it.each(["seat-home", "srv/seat-home", "/", "", "~/x"])("refuses the injected home %j", (home) => {
    expect(() => loadSeatBook({ seatsDir: writeSeats({ "a.md": GADGET_SEAT }), home })).toThrow(/home/);
  });

  it("keeps the checkout path's case for spawns while matching it case-insensitively", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": seat("a-seat", "repos:\n  - {path: ~/Src/Gadgets/, remote: acme/gadgets}\n") }) });

    expect(book.seats[0]!.paths).toEqual({ "acme/gadgets": "~/Src/Gadgets" });
  });

  it("throws, naming both files, when one path maps to two remotes across seats", () => {
    const first = seat("a-seat", "repos:\n  - {path: ~/p/kit, remote: acme/kit}\n");
    const second = seat("b-seat", "repos:\n  - {path: ~/P/Kit/, remote: acme/other-kit}\n");

    expect(() => loadSeatBook({ seatsDir: writeSeats({ "a.md": first, "b.md": second }) })).toThrow(/a\.md.*b\.md/);
  });

  it("stores a seat remote in lowercase so a deny and a lookup compare one form", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": seat("a-seat", "repos:\n  - {path: ~/p/mixed, remote: Acme/Mixed}\n") }) });

    expect(book.seats[0]!.remotes).toEqual(["acme/mixed"]);
    expect(lookupSeat(book, "acme/MIXED").kind).toBe("seat");
  });

  it("denies a configured hard-stop repo only when the charter carries that hard stop", () => {
    const charter = writeCharter("hard_stops:\n  - dotfiles-merge   # merging dotfiles\n");
    const hardStopRepos = { "dotfiles-merge": ["acme/dotfiles"] };

    expect(lookupSeat(loadSeatBook({ charterPath: charter, hardStopRepos }), "Acme/Dotfiles").kind).toBe("denied");
    expect(lookupSeat(loadSeatBook({ charterPath: writeCharter("hard_stops: []\n"), hardStopRepos }), "acme/dotfiles").kind).toBe("none");
    expect(lookupSeat(loadSeatBook({ charterPath: charter }), "acme/dotfiles").kind).toBe("none");
  });

  it("keeps each remote's local checkout path and omits repos with no remote or no path", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.md": GADGET_SEAT }) });

    expect(lookupSeat(book, "Acme/Gadgets")).toMatchObject({ kind: "seat", seat: { paths: { "acme/gadgets": "~/src/gadgets", "acme/shared-kit": "~/src/shared-kit" } } });
    expect(Object.keys(book.seats[0]!.paths)).toHaveLength(2);
  });

  it("ignores files without the .md extension", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "gadget.txt": "not a seat" }) });

    expect(book.seats).toEqual([]);
  });

  it.each([
    ["no frontmatter", "# notes\n"],
    ["another schema", "---\nschema: other/v1\nname: x\n---\n"],
    ["repos that is not a list", GADGET_SEAT.replace(/repos:\n( {2}- .*\n)+/, "repos: x\n")],
    ["unparseable yaml", "---\nschema: [\n---\n"],
    ["an empty repo path", GADGET_SEAT.replace("path: ~/src/gadgets,", 'path: "",')],
    ["a non-string repo path", GADGET_SEAT.replace("path: ~/src/gadgets,", "path: 7,")],
    ["a .git remote", GADGET_SEAT.replace("remote: acme/gadgets,", "remote: acme/gadgets.git,")],
    ["a URL remote", GADGET_SEAT.replace("remote: acme/gadgets,", 'remote: "https://github.com/acme/gadgets",')],
    ["a remote with a trailing space", GADGET_SEAT.replace("remote: acme/gadgets,", 'remote: "acme/gadgets ",')],
    ["a repo path with a .. segment", GADGET_SEAT.replace("path: ~/src/gadgets,", "path: ../../etc,")],
    ["a repo path with a . segment", GADGET_SEAT.replace("path: ~/src/gadgets,", "path: ~/src/./gadgets,")],
    ["a deny path with a .. segment", GADGET_SEAT.replace("~/src/parked-app", "~/src/../parked-app")],
  ])("throws, naming the file, when a seat file has %s", (_case, body) => {
    const seatsDir = writeSeats({ "a-good.md": SPROCKET_SEAT, "z-bad.md": body });

    expect(() => loadSeatBook({ seatsDir })).toThrow(/(invalid|unreadable) seat file .*z-bad\.md/);
  });

  it.each([
    ["is missing", () => join(scratch(), "absent.md")],
    ["has no frontmatter", () => writeCharterBody("# charter\n")],
    ["has a hard_stops that is not a list", () => writeCharter("hard_stops: dotfiles-merge\n")],
    ["has a hard_stops with a non-string entry", () => writeCharter("hard_stops: [dotfiles-merge, 3]\n")],
    ["has no hard_stops key", () => writeCharter("owner: someone\n")],
    ["has another schema", () => writeCharterBody("---\nschema: other/v1\nhard_stops: []\n---\n")],
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
    ["a .. name", "acme/.."],
    ["a . name", "acme/."],
  ])("refuses a repo key with %s before lookup", (_case, repo) => {
    expect(lookupSeat(book(), repo)).toMatchObject({ kind: "denied", reason: expect.stringMatching(/owner\/name/) });
  });

  it("refuses the .git form of a denied repo instead of resolving it", () => {
    expect(lookupSeat(book(), "acme/parked-app.git").kind).toBe("denied");
  });
});

describe("read_only repo entries", () => {
  const owner = seat("owner-seat", "repos:\n  - {path: ~/src/widgets, remote: acme/widgets}\ngrants_extra: [merge-on-green-approve]\n");
  const listing = (flag: string) =>
    seat("viewer-seat", `repos:\n  - {path: ~/src/widgets, remote: acme/widgets${flag}}\ngrants_extra: []\n`);

  it("gives the owning seat's grants and auto policy when another seat lists the remote read_only", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": owner, "b.md": listing(", read_only: true") }) });
    const lookup = lookupSeat(book, "acme/widgets");
    expect(lookup).toMatchObject({ kind: "seat", seat: { name: "owner-seat", grants: ["merge-on-green-approve"] } });
    expect(resolveEffectivePolicy(lookup).merge).toBe("auto");
  });

  it("does not treat a seat whose only entry for the remote is read_only as its owner", () => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "b.md": listing(", read_only: true") }) });
    expect(lookupSeat(book, "acme/widgets")).toEqual({ kind: "none" });
  });

  it.each([["absent", ""], ["false", ", read_only: false"]])("still narrows grants when read_only is %s", (_case, flag) => {
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": owner, "b.md": listing(flag) }) });
    expect(lookupSeat(book, "acme/widgets")).toMatchObject({ kind: "seat", seat: { grants: [] } });
  });

  it.each([["a string", ", read_only: yes-please"], ["a quoted true", ', read_only: "true"'], ["a number", ", read_only: 1"]])(
    "refuses a seat file whose read_only is %s",
    (_case, flag) => {
      const seatsDir = writeSeats({ "a.md": listing(flag) });
      expect(() => loadSeatBook({ seatsDir })).toThrow(/read_only/);
    },
  );
});

describe("seat paths with inner spaces", () => {
  const SPACED = "~/Library/Application Support/widget/x/bin";
  const load = (repoPath: string, home = "/srv/seat-home") =>
    loadSeatBook({ seatsDir: writeSeats({ "a.md": seat("a-seat", `repos:\n  - {path: ${JSON.stringify(repoPath)}, remote: acme/spaced}\n`) }), home });

  it("loads a repo path whose segments contain inner spaces and keeps it as written for spawns", () => {
    expect(load(SPACED).seats[0]!.paths["acme/spaced"]).toBe(SPACED);
  });

  it("keeps a run of inner spaces as written, since it names a different directory", () => {
    expect(load("~/Library/Application  Support/x").seats[0]!.paths["acme/spaced"]).toBe("~/Library/Application  Support/x");
  });

  it("keeps a segment that is a dot then a space then a word as written, since it is not a . or .. segment", () => {
    expect(load("~/Library/. Support/x").seats[0]!.paths["acme/spaced"]).toBe("~/Library/. Support/x");
  });

  it("matches a spaced deny_repos path to a spaced repo path, spelled with ~ or the home directory", () => {
    const denier = seat("a-seat", `repos: []\ndeny_repos: [${JSON.stringify("/srv/seat-home/Library/Application Support/x")}]\n`);
    const owner = seat("b-seat", `repos:\n  - {path: ${JSON.stringify("~/Library/Application Support/x")}, remote: acme/spaced}\n`);
    const book = loadSeatBook({ seatsDir: writeSeats({ "a.md": denier, "b.md": owner }), home: "/srv/seat-home" });

    expect(lookupSeat(book, "acme/spaced").kind).toBe("denied");
  });

  it.each([
    "~/Library/ Application Support/x",
    "~/Library/Application Support /x",
    "~/Library/ Support/x",
    "~/Library/Application Support /",
    "~/Library/. Support/../x",
    "~/Library/Application\u00a0Support/x",
    "~/Library/Application Support\u00a0/x",
    "~/Library/Application Support/./x",
    "~/Library/Application Support/../x",
    "~/Library/Application\tSupport/x",
    "~/Library/Application Support/*",
    "~/Library/Application Support/?",
    "~/Library/Application Support/[a]",
    "~/Library/Application Support/\"x\"",
    "~/Library/Application Support/'x'",
    "~/Library/Application Support/a\\b",
    "~/Library/Application Support/a$b",
  ])("still refuses the path %j", (repoPath) => {
    expect(() => load(repoPath)).toThrow(NOT_ALLOWED);
  });

  it("refuses a spaced path in deny_repos when it has a leading-space segment", () => {
    const seatsDir = writeSeats({ "a.md": seat("a-seat", `repos: []\ndeny_repos: [${JSON.stringify("~/a/ b")}]\n`) });

    expect(() => loadSeatBook({ seatsDir })).toThrow(NOT_ALLOWED);
  });
});

describe("a remote bound to checkout paths by several seats", () => {
  const bind = (name: string, path: string) => seat(name, `repos:\n  - {path: ${path}, remote: acme/widgets}\n`);

  it("throws, naming both seat files and both paths, when the paths differ", () => {
    const seatsDir = writeSeats({ "a-first.md": bind("first", "~/src/widgets"), "b-second.md": bind("second", "~/work/widgets") });

    expect(() => loadSeatBook({ seatsDir })).toThrow(/acme\/widgets.*~\/src\/widgets in .*a-first\.md.*~\/work\/widgets in .*b-second\.md/);
  });

  it("parses when both seats spell the same path differently", () => {
    const seatsDir = writeSeats({
      "a-first.md": bind("first", "~/src/widgets/"),
      "b-second.md": bind("second", "$HOME/src//widgets"),
      "c-third.md": bind("third", "/opt/tester/src/widgets"),
    });

    const book = loadSeatBook({ seatsDir, home: "/opt/tester" });

    expect(book.seats.map((s) => s.paths["acme/widgets"])).toEqual(["~/src/widgets", "$HOME/src/widgets", "/opt/tester/src/widgets"]);
  });
});

describe("visual_paths", () => {
  const remote = "repos:\n  - {path: ~/src/design, remote: acme/design}\n";
  const lookupDesign = (files: Record<string, string>) => lookupSeat(loadSeatBook({ seatsDir: writeSeats(files) }), "acme/design");

  it("reads a seat's visual paths and resolves it to merge:auto with them", () => {
    const lookup = lookupDesign({ "a.md": seat("design-seat", `${remote}visual_paths: ["packages/ui/**"]\n`) });

    expect(lookup).toMatchObject({ kind: "seat", seat: { visualPaths: ["packages/ui/**"] } });
    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "auto", visualPaths: ["packages/ui/**"] });
  });

  it("leaves a seat without visual paths and without the grant at owner-gate", () => {
    const lookup = lookupDesign({ "a.md": seat("plain-seat", remote) });

    expect(lookup).toMatchObject({ kind: "seat", seat: { name: "plain-seat" } });
    expect(lookup.kind === "seat" && "visualPaths" in lookup.seat).toBe(false);
    expect(resolveEffectivePolicy(lookup)).toEqual({ merge: "owner-gate", mergeMethod: "squash", fixer: true, seat: "plain-seat" });
  });

  it("gives a remote two opted-in seats share the union of their visual paths", () => {
    const lookup = lookupDesign({
      "a.md": seat("design-seat", `${remote}visual_paths: ["packages/ui/**", "**/*.stories.tsx"]\n`),
      "b.md": seat("app-seat", `${remote}visual_paths: ["**/*.stories.tsx", "baselines/**"]\n`),
    });

    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "auto", seat: "design-seat+app-seat", visualPaths: ["packages/ui/**", "**/*.stories.tsx", "baselines/**"] });
  });

  it("keeps a shared remote at owner-gate when one seat neither opted in nor holds the grant", () => {
    const lookup = lookupDesign({ "a.md": seat("design-seat", `${remote}visual_paths: ["packages/ui/**"]\n`), "b.md": seat("plain-seat", remote) });

    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "owner-gate" });
    expect(resolveEffectivePolicy(lookup)).not.toHaveProperty("visualPaths");
  });

  it("applies the opted-in seat's visual paths when the other seat holds the merge grant", () => {
    const lookup = lookupDesign({ "a.md": seat("design-seat", `${remote}visual_paths: ["packages/ui/**"]\n`), "b.md": seat("trusted-seat", `${remote}grants_extra: [merge-on-green-approve]\n`) });

    expect(resolveEffectivePolicy(lookup)).toMatchObject({ merge: "auto", visualPaths: ["packages/ui/**"] });
  });

  it.each([
    ["an empty list", "visual_paths: []\n"],
    ["a glob that cannot compile", `visual_paths: ["${"{a,b}".repeat(40)}"]\n`],
    ["an empty glob", 'visual_paths: [""]\n'],
  ])("refuses a seat file with %s", (_case, field) => {
    expect(() => loadSeatBook({ seatsDir: writeSeats({ "a.md": seat("design-seat", `${remote}${field}`) }) })).toThrow(/visual_paths/);
  });
});
