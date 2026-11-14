import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shadowAgentLanes } from "./agent-lanes.js";
import { enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task } from "./tick.test-helpers.js";

type Row = Record<string, unknown>;

const ORIGIN = "http://127.0.0.1:1";
const LANES = ["alpha", "beta", "gamma"];

function inventoryFetch(rows: Row[] | Error): typeof fetch {
  return async () => {
    if (rows instanceof Error) return new Response(JSON.stringify({ ok: false, error: rows.message, code: 70 }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, data: { initiatives: rows } }));
  };
}

function brief(root: string, slug: string, visibility: string): void {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "brief.md"), `---\nslug: ${slug}\nvisibility: ${visibility}\n---\nSynthetic brief\n`);
}

function charter(root: string, humanOnly: string[]): void {
  const dir = join(root, "claude-channels", "sources", "autonomy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "charter.md"), `---\nhuman_only_initiatives: ${JSON.stringify(humanOnly)}\n---\nSynthetic charter\n`);
}

/** alpha and beta agent-visible by brief, gamma owner-only by brief, beta listed human-only by the charter. */
function activeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-lanes-"));
  brief(root, "alpha", "agent-visible");
  brief(root, "beta", "agent-visible");
  brief(root, "gamma", "owner-only");
  charter(root, ["beta"]);
  return root;
}

const unfielded = (slugs: string[]): Row[] => slugs.map((slug) => ({ slug, human_only: false, agent_visible: true }));

describe("shadowAgentLanes", () => {
  it("keeps active-work's verdict and reads rpc when the rows carry the field, whatever the files say", async () => {
    const rows = [{ slug: "alpha", withheld_from_agents: true }, { slug: "gamma", withheld_from_agents: false }];

    const visible = await shadowAgentLanes(ORIGIN, activeRoot(), inventoryFetch(rows))(LANES);

    expect(visible).toEqual({ lanes: new Set(["gamma"]), read: "rpc" });
  });

  it("falls back to the files when no row carries the field, admitting a visible lane and withholding by brief and by charter", async () => {
    const visible = await shadowAgentLanes(ORIGIN, activeRoot(), inventoryFetch(unfielded(LANES)))(LANES);

    expect(visible).toEqual({ lanes: new Set(["alpha"]), read: "file" });
  });

  it("withholds a lane whose brief cannot be read in the fallback", async () => {
    const root = activeRoot();
    mkdirSync(join(root, "delta"));

    const visible = await shadowAgentLanes(ORIGIN, root, inventoryFetch(unfielded([...LANES, "delta"])))(["alpha", "delta"]);

    expect(visible).toEqual({ lanes: new Set(["alpha"]), read: "file" });
  });

  it("withholds every lane in the fallback when the charter cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-lanes-"));
    brief(root, "alpha", "agent-visible");

    const visible = await shadowAgentLanes(ORIGIN, root, inventoryFetch(unfielded(["alpha"])))(["alpha"]);

    expect(visible).toEqual({ lanes: new Set(), read: "file" });
  });

  it("does not fall back on a mixed answer: a row without the field stays withheld", async () => {
    const rows = [{ slug: "alpha" }, { slug: "beta", withheld_from_agents: true }];

    const visible = await shadowAgentLanes(ORIGIN, activeRoot(), inventoryFetch(rows))(LANES);

    expect(visible).toEqual({ lanes: new Set(), read: "rpc" });
  });

  it("does not fall back on an empty answer", async () => {
    const visible = await shadowAgentLanes(ORIGIN, activeRoot(), inventoryFetch([]))(LANES);

    expect(visible).toEqual({ lanes: new Set(), read: "rpc" });
  });

  it("fails closed when the inventory rpc fails", async () => {
    const read = shadowAgentLanes(ORIGIN, activeRoot(), inventoryFetch(new Error("daemon down")));

    await expect(read(LANES)).rejects.toThrow();
  });
});

describe("visibility_read on the wake row", () => {
  it("labels the wake file and judges the lane when an older daemon's inventory has no verdict field", async () => {
    const home = shadowHome();
    brief(home.activeRoot, "alpha", "agent-visible");
    charter(home.activeRoot, []);
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const rpc = fakeRpc({ tasks: [task(1)], bets: [selectedBet(1, 1, ["alpha/AL-1"])], inventory: unfielded(["alpha"]) });

    await shadowTickCli(home, rpc.fetch);

    const [wake, ...lanes] = readRows(home.shadowDir).flatMap((file) => file.rows);
    expect(wake).toMatchObject({ kind: "wake", visibility_read: "file" });
    expect(lanes.map((row) => row.task)).toEqual(["alpha/AL-1"]);
  });

  it("labels the wake rpc when the daemon sends its verdict", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const rpc = fakeRpc({ tasks: [task(1)], bets: [selectedBet(1, 1, ["alpha/AL-1"])] });

    await shadowTickCli(home, rpc.fetch);

    expect(readRows(home.shadowDir)[0]?.rows[0]).toMatchObject({ kind: "wake", visibility_read: "rpc" });
  });
});
