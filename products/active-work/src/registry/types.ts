/**
 * active-work's binding of `@titan-design/registry` (AW-a).
 *
 * The package's `Command` carries a third type parameter for the context, so
 * every command would otherwise have to spell out `Command<A, R, CommandContext>`.
 * These aliases bind it once, which is why all 60 command modules import from
 * here unchanged. The package is the implementation; this file is the product's
 * dialect of it.
 */
import type {
  AnyCommand as PkgAnyCommand,
  BaseContext,
  Command as PkgCommand,
} from '@titan-design/registry';
import { defineCommand as pkgDefineCommand } from '@titan-design/registry';

export interface CommandContext extends BaseContext {
  activeRoot: string;
  // The user's shell working directory, populated by interactive surfaces
  // (the CLI dispatcher and `aw` launcher). Left undefined by the daemon /
  // MCP server, whose process cwd is not the user's — those callers must pass
  // an explicit `cwd` arg to opt into cwd-based resolution.
  cwd?: string;
  // Set by each surface: 'agent' for MCP or a CLI run under an agent's environment,
  // 'owner' for the owner's plain terminal and the daemon's HTTP. Commands may hold
  // agents to stricter input rules; owner-only initiatives are served only to 'owner',
  // so a surface that sets nothing reads as restricted (TP-5453 P6b).
  caller?: 'owner' | 'agent';
}

export type Command<Args = unknown, Result = unknown> = PkgCommand<Args, Result, CommandContext>;
export type AnyCommand = PkgAnyCommand<CommandContext>;

export function defineCommand<Args, Result>(cmd: Command<Args, Result>): Command<Args, Result> {
  return pkgDefineCommand<Args, Result, CommandContext>(cmd);
}

export type { CliMeta, CliOption } from '@titan-design/registry';
