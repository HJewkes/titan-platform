// Claude Code hands a mod's module `h` and `Fragment` as globals; JSX here compiles to them.
import type { RenderElement as ModElement } from "claude-code";

declare global {
  function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ModElement;
  function Fragment(props: { children?: unknown }): ModElement;

  namespace JSX {
    type Element = ModElement;
    interface ElementChildrenAttribute {
      children: object;
    }
    interface IntrinsicAttributes {
      key?: string;
    }
  }
}
