import { describe, expect, it } from "vitest";
import { foldSeatEvents, scratchPathOf, seatStateSchema } from "./seat-state.js";

describe("foldSeatEvents", () => {
  it("starts an empty log at generation 0 with nothing held", () => {
    const state = foldSeatEvents([]);

    expect(state).toEqual({
      generation: 0,
      agents: [],
      holds: [],
      claims: [],
      background: [],
      authored: "",
      errors: [],
      unknownEvents: 0,
    });
  });

  it("counts one generation per teleport in a chain and keeps the seat's agents across it", () => {
    const log = [
      { kind: "spawn", agent: "sx-ab-1-fix" },
      { kind: "teleport", successor: "seat-a" },
      { kind: "spawn", agent: "sx-ab-2-fix" },
      { kind: "teleport" },
      { kind: "retire", agent: "sx-ab-1-fix" },
      { kind: "teleport" },
    ];

    const state = foldSeatEvents(log);

    expect(state.generation).toBe(3);
    expect(state.agents).toEqual(["sx-ab-2-fix"]);
  });

  it("replaces a worktree's claim with the latest one instead of merging patterns", () => {
    const log = [
      { kind: "claim", owner: "sx-a", worktree: "/w/one", patterns: ["src/a.ts", "src/b.ts"] },
      { kind: "claim", owner: "sx-b", worktree: "/w/two" },
      { kind: "claim", owner: "sx-a", worktree: "/w/one", patterns: ["src/c.ts"] },
    ];

    const state = foldSeatEvents(log);

    expect(state.claims).toEqual([
      { owner: "sx-b", worktree: "/w/two", patterns: [] },
      { owner: "sx-a", worktree: "/w/one", patterns: ["src/c.ts"] },
    ]);
  });

  it("drops a released claim and an unheld hold", () => {
    const log = [
      { kind: "claim", owner: "sx-a", worktree: "/w/one" },
      { kind: "hold", target: "org/repo#1", reason: "gate-a" },
      { kind: "release", worktree: "/w/one" },
      { kind: "unhold", target: "org/repo#1" },
    ];

    const state = foldSeatEvents(log);

    expect(state.claims).toEqual([]);
    expect(state.holds).toEqual([]);
  });

  it("replaces a hold's reason with the latest hold on the same target", () => {
    const log = [
      { kind: "hold", target: "org/repo#1", reason: "gate-a" },
      { kind: "hold", target: "org/repo#2", reason: "gate-a" },
      { kind: "hold", target: "org/repo#1", reason: "gate-b" },
    ];

    expect(foldSeatEvents(log).holds).toEqual([
      { target: "org/repo#2", reason: "gate-a" },
      { target: "org/repo#1", reason: "gate-b" },
    ]);
  });

  it("refuses a background command run from under /tmp without throwing", () => {
    const log = [{ kind: "background", id: "watch", command: "node watch.js", cwd: "/tmp/work" }];

    const state = foldSeatEvents(log);

    expect(state.background).toEqual([]);
    expect(state.errors).toEqual([
      { index: 0, kind: "background", message: expect.stringContaining("/tmp/work") },
    ]);
  });

  it.each([
    ["an argument under /private/tmp", "tail -f /private/tmp/x.log", "/srv/w"],
    ["a flag value under /tmp", "run --out=/tmp/out", "/srv/w"],
    ["a scratchpad cwd", "node watch.js", "/srv/session/scratchpad"],
    ["a relative path into a scratchpad", "node scratchpad/watch.js", "/srv/w"],
    ["a path under the host's tmpdir", "node /var/folders/t/x.js", "/srv/w"],
    ["a stdout redirect into /tmp", "node w.js >/tmp/out.log 2>&1", "/srv/w"],
    ["a stderr redirect into /tmp", "node w.js 2>/tmp/err", "/srv/w"],
    ["an option glued to a /tmp value", "node w.js -o/tmp/x", "/srv/w"],
    ["an unspaced && after cd /tmp", "cd /tmp&&node x", "/srv/w"],
    ["a pipe into a /tmp file", "node w.js|tee /tmp/log", "/srv/w"],
    ["a quoted /tmp path", "node w.js --log '/tmp/a b.log'", "/srv/w"],
    ["a literal $TMPDIR path", "node $TMPDIR/x.js", "/srv/w"],
    ["a literal ${TMPDIR} path", "node ${TMPDIR}/x.js", "/srv/w"],
    ["a $TMPDIR cwd", "node x.js", "$TMPDIR"],
    ["a cwd at the /private real path of the tmpdir", "node x.js", "/private/var/folders/t/T"],
  ])("refuses a background command with %s", (_case, command, cwd) => {
    const state = foldSeatEvents([{ kind: "background", id: "b", command, cwd }], { tmpdir: "/var/folders/t/" });

    expect(state.background).toEqual([]);
    expect(state.errors).toHaveLength(1);
  });

  it("keeps a background command outside temp space and replaces it by id", () => {
    const log = [
      { kind: "background", id: "watch", command: "node a.js", cwd: "/srv/w" },
      { kind: "background", id: "watch", command: "node b.js --dir /srv/tmp", cwd: "/srv/w" },
      { kind: "background", id: "serve", command: "node s.js", cwd: "/srv/w" },
      { kind: "background-stop", id: "serve" },
    ];

    const state = foldSeatEvents(log);

    expect(state.background).toEqual([{ id: "watch", command: "node b.js --dir /srv/tmp", cwd: "/srv/w" }]);
    expect(state.errors).toEqual([]);
  });

  it("ignores and counts unknown event kinds", () => {
    const log = [{ kind: "future-thing" }, "not an event", null, { kind: "teleport" }, { nokind: 1 }];

    const state = foldSeatEvents(log);

    expect(state.unknownEvents).toBe(4);
    expect(state.generation).toBe(1);
  });

  it("records a malformed known event as an error and folds on", () => {
    const state = foldSeatEvents([{ kind: "claim", owner: "sx-a" }, { kind: "teleport" }]);

    expect(state.errors).toEqual([{ index: 0, kind: "claim", message: expect.stringContaining("worktree") }]);
    expect(state.generation).toBe(1);
  });

  it("preserves the authored block byte for byte, latest wins", () => {
    const text = "  # Seat\r\n\n- keep   spacing\té\u{1F600}\n\n";
    const log = [{ kind: "authored", text: "old" }, { kind: "authored", text }];

    expect(foldSeatEvents(log).authored).toBe(text);
  });

  it("produces state that satisfies seatStateSchema", () => {
    const state = foldSeatEvents([{ kind: "teleport" }, { kind: "hold", target: "t", reason: "r" }]);

    expect(seatStateSchema.safeParse(state).success).toBe(true);
  });

  it("does not mutate the starting state", () => {
    const from = foldSeatEvents([{ kind: "spawn", agent: "sx-a" }]);
    const snapshot = structuredClone(from);

    foldSeatEvents([{ kind: "retire", agent: "sx-a" }, { kind: "teleport" }], {}, from);

    expect(from).toEqual(snapshot);
  });
});

describe("scratchPathOf", () => {
  it("does not treat a directory merely named like tmp as temp space", () => {
    expect(scratchPathOf("ls /tmpfiles /srv/scratchpads", "/srv/w")).toBeUndefined();
  });

  it("accepts redirects and operators that stay outside temp space", () => {
    expect(scratchPathOf("cd /srv/a&&node w.js >/srv/log 2>&1 | tee -a/srv/b", "/srv/w")).toBeUndefined();
  });

  it("does not read a URL path as a filesystem path", () => {
    expect(scratchPathOf("curl https://h/scratchpad/x", "/srv/w")).toBeUndefined();
  });

  it("names the temp path it refused", () => {
    expect(scratchPathOf("node w.js 2>/tmp/err", "/srv/w")).toBe("/tmp/err");
  });
});
