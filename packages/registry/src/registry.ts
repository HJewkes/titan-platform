import type { AnyCommand, BaseContext } from "./types.js";

export interface CommandRegistry<Ctx extends BaseContext = BaseContext> {
  register(cmd: AnyCommand<Ctx>): void;
  get(name: string): AnyCommand<Ctx> | undefined;
  has(name: string): boolean;
  /** Every command, sorted by name so help output and tool lists are stable. */
  list(): AnyCommand<Ctx>[];
  readonly size: number;
}

/** A registry is an instance, not a module singleton, so each product owns its own. */
export function createRegistry<Ctx extends BaseContext = BaseContext>(): CommandRegistry<Ctx> {
  const commands = new Map<string, AnyCommand<Ctx>>();
  return {
    register(cmd) {
      if (commands.has(cmd.name)) throw new Error(`Command already registered: ${cmd.name}`);
      commands.set(cmd.name, cmd);
    },
    get: (name) => commands.get(name),
    has: (name) => commands.has(name),
    list: () => [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get size() {
      return commands.size;
    },
  };
}
