import { expect, test } from "claude-code/testing";

const NOW = Date.parse("2026-01-15T12:00:00Z");

// A snapshot as titan-fleet-feed prints it, with invented agents and accounts.
const SNAPSHOT = {
  atMs: NOW - 2_000,
  agents: [
    {
      name: "builder-a",
      presence: "live",
      profile: "implementer",
      model: "claude-opus-5-5",
      account: "acct-a",
      task: "DEMO-12",
      report: { word: "DONE", pr: "#41", atMs: NOW - 180_000 },
      context: { source: "status-line", pct: 44, atMs: NOW - 20_000 },
      cost: { usd: 4.1, atMs: NOW - 20_000 },
    },
  ],
  accounts: [
    {
      account: "acct-a",
      agents: 1,
      fiveHour: { usedPct: 62, resetsAtMs: null },
      sevenDay: { usedPct: 21, resetsAtMs: null },
      readAtMs: NOW - 40_000,
      stale: false,
      authFail: false,
    },
  ],
  slots: { held: 3, cap: 12 },
  errors: [],
};

const PANE = {
  plugin: "fleet-panel",
  component: "Pane",
  requestId: "fleet",
  props: { title: "Fleet", isFocused: false, bodyColumns: 72, placement: "dock", scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("/fleet starts the feed and the pane draws its roster and account usage", async ($, on) => {
  let argv: readonly string[] = [];
  on("command.register", () => ({ value: { command: "fleet" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("clock.now", () => ({ value: NOW }));
  on("process.spawn", async function* (_, e) {
    argv = e.argv;
    const line = `${JSON.stringify(SNAPSHOT)}\n`;
    yield { stream: "stdout", text: line.slice(0, 100) };
    yield { stream: "stdout", text: line.slice(100) };
    return { value: { code: 0, signal: null } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  await $.command.run({ command: "fleet", args: "", presentation: { isFullscreen: true, columns: 160 } } as never);
  await settle();

  expect(argv).toEqual(["titan-fleet-feed"]);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never);
    expect((await ui.find({ type: "Text", text: /^fleet / }))?.text).toBe("fleet 1 live · 0 detached · 0 exited  slots 3/12  as of 2s");
    expect((await ui.find({ type: "Text", text: /builder-a/ }))?.text).toContain("DONE");
    expect((await ui.find({ type: "Text", text: /^acct-a/ }))?.text).toContain("5h");
    await ui.unmount();
  }
});

test("the pane says the feed stopped, and why, when it exits", async ($, on) => {
  on("command.register", () => ({ value: { command: "fleet" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stderr", text: "Error: spawn agent-chat ENOENT\n" };
    return { value: { code: 1, signal: null } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  await $.command.run({ command: "fleet", args: "", presentation: { isFullscreen: true, columns: 160 } } as never);
  await settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as never);
  expect((await ui.find({ type: "Text", text: /feed exited/ }))?.text).toContain("spawn agent-chat ENOENT");
  await ui.unmount();
});
