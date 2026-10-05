import type { Node } from "web-tree-sitter";

/**
 * True for a JSX node that renders an element. A fragment (`<>…</>`) parses as a
 * `jsx_element` whose opening tag has no name, and adds no depth because it renders no node.
 */
function rendersElement(node: Node): boolean {
  if (node.type === "jsx_self_closing_element") return true;
  if (node.type !== "jsx_element") return false;
  return node.childForFieldName("open_tag")?.childForFieldName("name") != null;
}

/**
 * Deepest chain of rendered JSX elements under `root`, root included (C-97 S1). The walk
 * continues through `jsx_expression` containers and inline callbacks, so
 * `rows.map(r => <Row/>)` inside `<tbody>` nests under it, and JSX in an attribute sits one
 * below its owning element. It does not descend into a child where `opensFunction` holds:
 * that function is measured on its own.
 */
export function jsxDepthOf(root: Node, opensFunction: (node: Node) => boolean): number {
  let max = 0;
  const visit = (node: Node, depth: number): void => {
    const own = rendersElement(node) ? depth + 1 : depth;
    if (own > max) max = own;
    for (const child of node.namedChildren) {
      if (child && !opensFunction(child)) visit(child, own);
    }
  };
  visit(root, 0);
  return max;
}
