// The slice of Claude Code's mod API this mod calls, under the contract's own names. Claude Code
// writes the full contract into a mod folder only when a session loads it from there, so CI types
// against this subset; `claude plugin test` checks the calls against the real engine.

declare module "claude-code" {
  export type RenderElement = { readonly __element: true };
  type Child = RenderElement | string | number | false | null | undefined | Child[];
  export type ElementConstructor<P> = (props: P & { children?: Child }) => RenderElement;

  export interface TextProps {
    color?: string;
    dimColor?: boolean;
    wrap?: "wrap" | "truncate";
  }

  export interface BoxProps {
    flexDirection?: "row" | "column";
    width?: number;
  }

  export type ProcessSpawnChunk = { stream: "stdout" | "stderr"; text: string };
  export type ProcessSpawnResult = { code: number | null; signal: string | null };
  export type HookStream<C, R> = AsyncGenerator<C, R>;

  interface PaneRender {
    surface: string;
    props: { bodyColumns: number };
  }

  export interface EngineInterface {
    clock: { now(): Promise<number> };
    command: { register(command: { name: string; description: string }): Promise<unknown> };
    process: { spawn(request: { argv: string[] }): HookStream<ProcessSpawnChunk, ProcessSpawnResult> };
    ui: {
      open(request: { id: string; title: string }): Promise<{ isPlaced: boolean; reason?: string }>;
      invalidate(hook: "ui.render"): void;
      resolve(event: PaneRender): { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps> };
    };
  }

  type Next<E, R> = (event: E) => Promise<R>;

  export interface On {
    (event: "session.start", hook: ($: EngineInterface, e: object, next: Next<object, unknown>) => Promise<unknown>): void;
    (event: "command.run", filter: { command: string }, hook: ($: EngineInterface) => Promise<{ text: string }>): void;
    (
      event: "ui.render",
      filter: { component: "Pane"; requestId: string },
      hook: ($: EngineInterface, e: PaneRender) => Promise<RenderElement>,
    ): void;
  }

  export type PluginOptions = Record<string, unknown>;
}
