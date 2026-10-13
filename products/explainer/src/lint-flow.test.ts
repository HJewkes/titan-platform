import { describe, expect, it } from "vitest";
import { l0HardPass, runL0, L0_CHECKS } from "./eval-l0.js";
import { flowCheck } from "./lint-flow.js";
import { GOOD_BEATS, lint, tour, withBeat, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

const flow = (beats = GOOD_BEATS, video: Record<string, unknown> = {}) => lint(tour(beats, video), [flowCheck]);
const spoken = (id: string, text: string, extra: Record<string, unknown> = {}) => withBeat(id, { spoken: text, extra });

describe("flow lints on the positive control", () => {
  it("passes every Q-F rule", () => {
    const rows = [...flow().values()];

    expect(rows.map((r) => r.check_id)).toEqual(
      ["Q-F1", "Q-F2", "Q-F4", "Q-F5", "Q-F7", "Q-F8", "Q-F9", "Q-F10", "Q-F11", "Q-F14", "Q-F15", "Q-F16"],
    );
    expect(rows.filter((r) => !r.pass)).toEqual([]);
  });

  it("is registered with the L0 run", () => {
    const ids = runL0(tour()).map((r) => r.check_id);

    expect(L0_CHECKS).toContain(flowCheck);
    expect(ids).toContain("Q-F1");
    expect(ids).toContain("Q-V1");
  });
});

describe("Q-F1 beat links", () => {
  it("fails announcement openers and topic jumps", () => {
    const swap: Record<string, string> = { w2: "Here is the desk server.", w3: "Parcels weigh little.", k2: "Vans park outside." };
    const beats = GOOD_BEATS.map(([id, chapter, fn, text, extra]): BeatSpec => [id, chapter, fn, swap[id] ?? text, extra]);

    const row = flow(beats).get("Q-F1");

    expect(row).toMatchObject({ pass: false, detail_beats: ["w2", "w3", "k2"] });
    expect(row?.value).toBeCloseTo(4 / 7, 3);
  });

  it("fails when one connective carries most links", () => {
    const beats = GOOD_BEATS.map((s): BeatSpec => (["h2", "w2", "w3", "w4", "k2", "k3", "c2"].includes(s[0]) ? [s[0], s[1], s[2], `So ${s[3]}`, s[4]] : s));

    expect(flow(beats).get("Q-F1")).toMatchObject({ value: 1, pass: false });
  });
});

describe("Q-F2 chapter hand-offs", () => {
  it("drops a hand-off with no connector and no question taken up", () => {
    const beats = withBeat("k1", { spoken: "Every row is stored once.", extra: { connector_in: undefined } });

    expect(flow(beats).get("Q-F2")?.detail_beats).toEqual(["k1"]);
  });

  it("keeps a hand-off that answers the question the last chapter ended on", () => {
    const beats = withBeat("k1", { extra: { connector_in: undefined } });

    expect(flow(beats).get("Q-F2")?.pass).toBe(true);
  });
});

describe("Q-F4 and Q-F5 thesis and pivot", () => {
  it("fails a thesis never voiced early and refs out of place", () => {
    const row = flow(GOOD_BEATS, { thesis_mechanism: "parcels route through hubs by weight", thesis_refs: ["c1", "w4", "h1"] }).get("Q-F4");

    expect(row).toMatchObject({ value: 3, pass: false });
  });

  it("fails a missing thesis_refs", () => {
    expect(flow(GOOD_BEATS, { thesis_refs: undefined }).get("Q-F4")?.pass).toBe(false);
  });

  it("needs exactly one pivot line", () => {
    const twice = spoken("k2", "Now, how does the desk refuse? It drops the label, so the courier sees it.");

    expect(flow(twice).get("Q-F5")).toMatchObject({ value: 2, pass: false });
  });
});

describe("beat and chapter shape", () => {
  it("Q-F7 flags a chapter question that is neither why, how nor about the viewer", () => {
    const chapters = tour().chapters.map((c) => (c.id === "ch2" ? { ...c, question: "Which part matters?" } : c));

    expect(lint(tour(GOOD_BEATS, {}, chapters), [flowCheck]).get("Q-F7")?.detail_beats).toEqual(["w1"]);
  });

  it("Q-F8 flags a body beat outside six to twenty seconds", () => {
    expect(flow(withBeat("w2", { extra: { plannedS: 34 } })).get("Q-F8")?.detail_beats).toEqual(["w2"]);
  });

  it("Q-F9 allows five list items, fails six, and sends spoken paths to a ref beat", () => {
    const five = spoken("w2", "The desk reads the scan, the parcel, the van, the hub, and the ledger.");
    const six = spoken("w2", "The desk reads the scan, the parcel, the van, the hub, the route and the ledger.");
    const paths = spoken("w2", "Read src/desk.ts, then src/ledger.ts, then src/scan.ts.");

    expect(flow(five).get("Q-F9")?.pass).toBe(true);
    expect(flow(six).get("Q-F9")?.detail_beats).toEqual(["w2"]);
    expect(flow(paths).get("Q-F9")?.detail_beats).toEqual(["w2"]);
    expect(flow(withBeat("w2", { spoken: "Read src/desk.ts, then src/ledger.ts, then src/scan.ts.", extra: { mode: "ref" } })).get("Q-F9")?.pass).toBe(true);
  });

  it("Q-F10 flags a VERDICT beat between WHAT and HOW in one chapter", () => {
    const beats = [...GOOD_BEATS];
    beats.splice(7, 0, ["v1", "ch3", "VERDICT", "Adopt the row check."]);
    beats.splice(6, 0, ["w5", "ch3", "WHAT", "The ledger answers each row request."]);

    expect(flow(beats).get("Q-F10")?.detail_beats).toEqual(["v1"]);
  });
});

describe("Q-F11 close", () => {
  it("fails a long outro that sends the viewer off to read", () => {
    const row = flow(spoken("c2", "Start reading at the desk server, and thanks for watching today.")).get("Q-F11");

    expect(row).toMatchObject({ value: 2, detail_beats: ["c2"] });
  });

  it("fails an untyped close", () => {
    expect(flow(GOOD_BEATS, { close_type: "TODO: close type" }).get("Q-F11")?.pass).toBe(false);
  });
});

describe("warnings and plain opening", () => {
  it("Q-F14 and Q-F15 warn without failing the hard filter", () => {
    const flat = GOOD_BEATS.map((s): BeatSpec => [s[0], s[1], s[2], `The ${s[0]} beat states one fact.`, s[4]]);
    const rows = flow(flat);

    expect(rows.get("Q-F14")).toMatchObject({ severity: "warning", value: 0, pass: false });
    expect(rows.get("Q-F15")).toMatchObject({ severity: "warning", pass: false, detail_beats: ["k1"] });
    expect(l0HardPass([rows.get("Q-F14")!, rows.get("Q-F15")!])).toBe(true);
  });

  it("Q-F16 fails when an internal identifier comes in the first words", () => {
    const row = flow(spoken("h1", "The order_service module refuses a parcel that never arrived.")).get("Q-F16");

    expect(row).toMatchObject({ pass: false, detail_beats: ["h1"] });
    expect(row?.value).toBeLessThan(0.01);
  });
});
