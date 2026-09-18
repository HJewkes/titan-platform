import { describe, it, expect } from "vitest";
import { getLanguageFromPath, parseFile, shouldIncludeFile } from "./index.js";

const COMPONENT = `import type { ReactNode } from "react";

interface ListProps<T> {
  items: readonly T[];
  title?: ReactNode;
  loading: boolean;
  getKey: (item: T) => string;
}

export const identity = <T,>(value: T): T => value;

export function List<T>({ items, title, loading, getKey }: ListProps<T>) {
  if (loading) return <span aria-busy="true" />;
  return (
    <>
      {title && <h2 className="title">{title}</h2>}
      <ul>
        {items.map((item) => (
          <li key={getKey(item)}>{items.length > 1 ? <b>{getKey(item)}</b> : getKey(item)}</li>
        ))}
      </ul>
    </>
  );
}
`;

const ANGLE_BRACKET_ASSERTION = `export function asText(raw: unknown): string {
  const text = <string>raw;
  return text.length > 3 ? text : "";
}
`;

describe("a .tsx file indexed as typescript", () => {
  it("parses a JSX component without a syntax error", async () => {
    const file = await parseFile(COMPONENT, "src/List.tsx", getLanguageFromPath("src/List.tsx") ?? "");

    expect(file.tree.rootNode.hasError).toBe(false);
    expect(file.tree.rootNode.descendantsOfType("jsx_element").length).toBeGreaterThan(0);
  });

  it("keeps reporting the language it was asked for", async () => {
    const file = await parseFile(COMPONENT, "src/List.tsx", "typescript");

    expect(file.language).toBe("typescript");
  });
});

describe("a .ts file with an angle-bracket type assertion", () => {
  it("still parses with the typescript grammar and no error", async () => {
    const file = await parseFile(ANGLE_BRACKET_ASSERTION, "src/as-text.ts", "typescript");

    expect(file.tree.rootNode.hasError).toBe(false);
    expect(file.tree.rootNode.descendantsOfType("type_assertion")).toHaveLength(1);
  });
});

describe("JavaScript sources the parser has no grammar for", () => {
  it("are rejected by the filter and have no language, so a walk skips them without throwing", () => {
    for (const path of ["src/legacy.js", "src/Widget.jsx"]) {
      expect(shouldIncludeFile(path, ["javascript", "typescript"])).toBe(false);
      expect(getLanguageFromPath(path)).toBeNull();
    }
  });
});
