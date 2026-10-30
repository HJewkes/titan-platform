// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import { AnswerSourceProvider } from "./data/submit.js";
import { TapSheet } from "./pages/TapSheet.js";
import { findReadingTapSheet, findTapSheet } from "./tap-sheet.test-helpers.js";

// A TapSheet renders its read-back only after the prepare answers, so a test that looks the sheet up itself and queries it
// at once races that answer (TP-4634). Sheets open through tap-sheet.test-helpers, which wait the read-back out.

const SRC = dirname(fileURLToPath(import.meta.url));

const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => join(dir, path));

function sheetTestIds(): string[] {
  const ids = new Set<string>();
  for (const file of filesUnder(join(SRC, "pages")).filter((path) => path.endsWith(".tsx"))) {
    const source = readFileSync(file, "utf8");
    for (const opening of source.matchAll(/<TapSheet\b/g)) {
      const testID = /testID="([^"]+)"/.exec(source.slice(opening.index))?.[1];
      if (testID !== undefined) ids.add(testID);
    }
  }
  return [...ids].sort();
}

const directLookup = (id: string): RegExp => new RegExp(`(?:get|find)(?:All)?ByTestId\\(\\s*["'\`]${id}["'\`]\\s*\\)`);

function renderHeldSheet(): (answer: JsonEnvelope<unknown>) => Promise<void> {
  let answer!: (envelope: JsonEnvelope<unknown>) => void;
  const prepared = new Promise<JsonEnvelope<unknown>>((resolve) => (answer = resolve));
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: new Date(0).toISOString(), calls: {} }), "text/html");
  const inner = pageDataSource({ doc: page });
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: () => prepared };
  render(
    <RpcProvider source={inner}>
      <AnswerSourceProvider value={source}>
        <TapSheet<{ status: "ready"; confirm: string; readAt: string; effect: string }>
          commands={{ prepare: "fixture.prepare", act: "fixture.act", args: {}, invalidates: [] }}
          verb="Do it"
          reading="Reading"
          command={undefined}
          renderReadBack={(ready) => <p data-testid="sheet-readback">{ready.effect}</p>}
          testID="sheet"
          onClose={() => undefined}
        />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return (envelope) => act(async () => answer(envelope));
}

afterEach(() => {
  cleanup();
});

describe("tests that open a confirm sheet", () => {
  const ids = sheetTestIds();

  it("find every TapSheet the pages mount", () => {
    expect(ids).toEqual(expect.arrayContaining(["agent-retire-confirm", "agent-retire-force", "inbox-confirm"]));
  });

  it("open each sheet through findTapSheet, never by a bare lookup that races the prepare", () => {
    const offenders = filesUnder(SRC)
      .filter((path) => path.endsWith(".test.tsx"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return ids.filter((id) => directLookup(id).test(source)).map((id) => `${relative(SRC, file)}: ${id}`);
      });
    expect(offenders).toEqual([]);
  });

  it("see the sheet reading while its prepare is held, and its read-back once the prepare answers", async () => {
    const answerPrepare = renderHeldSheet();
    const reading = await findReadingTapSheet("sheet");
    expect(within(reading).queryByTestId("sheet-readback")).toBeNull();

    await answerPrepare(successEnvelope({ status: "ready", confirm: "c".repeat(64), readAt: new Date(0).toISOString(), effect: "Do the fixture thing" }));

    expect(within(await findTapSheet("sheet")).getByTestId("sheet-readback").textContent).toBe("Do the fixture thing");
  });
});
