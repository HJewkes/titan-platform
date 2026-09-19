// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SNAPSHOT_FORMAT, createRpcClient, type Snapshot } from "@titan-design/rpc-client";
import { SNAPSHOT_ELEMENT_ID, embedSnapshot, pageDataSource, readEmbeddedSnapshot } from "./embedded-snapshot.js";

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><script type="module">boot()</script></head><body><div id="root"></div></body></html>';

function snapshotSaying(text: string): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2026-09-18T12:00:00.000Z",
    calls: { '["note.get",{"id":"n1"}]': { ok: true, data: { text } } },
  };
}

function pageFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("embedded snapshots", () => {
  it("round-trips a snapshot through a built page", () => {
    const snapshot = snapshotSaying("hello");
    expect(readEmbeddedSnapshot(pageFrom(embedSnapshot(PAGE, snapshot)))).toEqual(snapshot);
  });

  it("keeps a value containing a closing script tag inside the element", () => {
    const hostile = snapshotSaying('</script><script>alert("x")</script><!--');
    const doc = pageFrom(embedSnapshot(PAGE, hostile));
    expect(doc.querySelectorAll("script")).toHaveLength(2);
    expect(readEmbeddedSnapshot(doc)).toEqual(hostile);
  });

  it("replaces a snapshot already embedded instead of adding a second", () => {
    const html = embedSnapshot(embedSnapshot(PAGE, snapshotSaying("old")), snapshotSaying("new"));
    expect(html.split(`id="${SNAPSHOT_ELEMENT_ID}"`)).toHaveLength(2);
    expect(readEmbeddedSnapshot(pageFrom(html))?.calls['["note.get",{"id":"n1"}]']).toEqual({ ok: true, data: { text: "new" } });
  });

  it("inserts a replacement-pattern-looking value verbatim", () => {
    const tricky = snapshotSaying("$& and $1 and $'");
    expect(readEmbeddedSnapshot(pageFrom(embedSnapshot(PAGE, tricky)))).toEqual(tricky);
  });

  it("finds nothing in a page a daemon serves", () => {
    expect(readEmbeddedSnapshot(pageFrom(PAGE))).toBeUndefined();
  });

  it("rejects an embedded file of another format", () => {
    const html = PAGE.replace("</head>", `<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">{"format":"x"}</script></head>`);
    expect(() => readEmbeddedSnapshot(pageFrom(html))).toThrow(/Unsupported snapshot format/);
  });
});

describe("pageDataSource", () => {
  it("answers from the embedded snapshot when the page carries one", async () => {
    const source = pageDataSource({ doc: pageFrom(embedSnapshot(PAGE, snapshotSaying("offline"))) });
    const client = createRpcClient<{ "note.get": { args: { id: string }; result: { text: string } } }>(source);
    expect(await client.call("note.get", { id: "n1" })).toEqual({ text: "offline" });
  });

  it("calls the daemon when the page carries no snapshot", async () => {
    const source = pageDataSource({ doc: pageFrom(PAGE), origin: "http://127.0.0.1:9" });
    expect(await source.call("note.get", { id: "n1" })).toMatchObject({ ok: false, code: 69 });
  });
});
