// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable.js";

afterEach(cleanup);

interface Item {
  name: string;
  depth: number;
  lines: number;
}

const columns: Column<Item>[] = [
  { header: "Name", render: (item) => item.name },
  { header: "Lines", hint: "lower is better", align: "right", render: (item) => item.lines },
];

const rows: Item[] = [
  { name: "src", depth: 0, lines: 120 },
  { name: "src/io.ts", depth: 1, lines: 40 },
];

function renderTable(indent?: (item: Item) => number): void {
  render(<DataTable caption="Files" columns={columns} rows={rows} rowKey={(item) => item.name} indent={indent} />);
}

describe("DataTable", () => {
  it("shows a header per column with its hint, and a row per item", () => {
    renderTable();
    expect(screen.getByRole("table", { name: "Files" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Lineslower is better"]);
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["src", "120"],
      ["src/io.ts", "40"],
    ]);
  });

  it("indents only the first cell of a row by its depth", () => {
    renderTable((item) => item.depth);
    const [first, second] = within(screen.getAllByRole("row")[2]!).getAllByRole("cell");
    expect(first!.style.paddingLeft).toBe("1.75rem");
    expect(second!.style.paddingLeft).toBe("");
  });

  it("leaves rows unindented without an indent", () => {
    renderTable();
    const [first] = within(screen.getAllByRole("row")[2]!).getAllByRole("cell");
    expect(first!.style.paddingLeft).toBe("");
  });
});
