/**
 * Who may run each console command. Every command the registry serves carries a class:
 *
 * - `read` runs anywhere, as it always has.
 * - `deposit` runs over HTTP: on loopback, where the request guard already demands an
 *   allowlisted Origin or `X-Titan-Client` on every POST, or on the LAN with any credential.
 * - `owner-write` answers for the owner, so it runs only for a session cookie on the LAN
 *   listener, from a peer that is not this machine, and only while `TITAN_CONSOLE_OWNER_WRITES`
 *   is on. Loopback has no credentials and the bearer is a file every same-user process can
 *   read, so neither may answer for the owner. A same-user agent can still mint a login link,
 *   so a cookie from this machine's own addresses is refused too.
 *
 * Commands run only through `POST /rpc/:name`, so no owner-write command is reachable by GET.
 * The OS account is still the trust boundary: this stops an agent answering for the owner by
 * accident or as a confused deputy, not a hostile process with the user's privileges.
 * Refusals carry fixed text and never echo a header, cookie, token or login code.
 */
import type { RequestAuth, Surface } from "@titan-design/daemon";
import { EXIT, type AnyCommand, type BaseContext, type Command } from "@titan-design/registry";

const COMMAND_CLASSES = ["read", "deposit", "owner-write"] as const;
type CommandClass = (typeof COMMAND_CLASSES)[number];

/** `in-process` is a call made inside the daemon, such as the first-paint snapshot. */
export type ConsoleSurface = Surface | "in-process";

export interface ConsoleContext extends BaseContext {
  surface: ConsoleSurface;
  /** What the LAN listener's auth gate recorded; null on loopback, which is never gated. */
  auth: RequestAuth | null;
  /** `TITAN_CONSOLE_OWNER_WRITES=1`; off until the LAN carries TLS. */
  ownerWrites: boolean;
}

/** The owner-console presence proof: when the owner's verified session cookie was issued. */
interface OwnerPresence {
  issuedAt: number;
}

interface OwnerWriteContext extends ConsoleContext {
  ownerPresence: OwnerPresence;
}

/**
 * An owner-write handler carries `ownerWrite: true` from its definition, so a runtime check can
 * tell it apart from a read or a deposit; `run`'s parameter types are gone by then.
 */
type OwnerWriteHandler<Args, Result> = Command<Args, Result, OwnerWriteContext> & { readonly ownerWrite: true };

/**
 * `run` is a method on `Command`, so its context parameter is bivariant and a handler that needs
 * `OwnerWriteContext` would typecheck as a read or a deposit. This is `never` for any context a
 * plain console context cannot satisfy, and refuses the owner-write mark, so that wrapping fails to compile.
 */
type ServedWithoutOwner<Ctx> = ConsoleContext extends Ctx ? { readonly ownerWrite?: never } : never;

export type ClassedCommand = AnyCommand<ConsoleContext> & { readonly commandClass: CommandClass };

/** Thrown with `EXIT.NOPERM`, which `POST /rpc/:name` answers with 403. */
class CommandRefusedError extends Error {
  readonly code = EXIT.NOPERM;

  constructor(commandClass: CommandClass, reason: string) {
    super(`${commandClass} command refused: ${reason}`);
    this.name = "CommandRefusedError";
  }
}

export const REFUSALS = {
  notHttp: "it runs only over HTTP",
  noCredential: "it needs the owner's session cookie on the LAN listener; loopback carries no credential",
  bearer: "it needs the owner's session cookie; a bearer token cannot answer for the owner",
  disabled: "owner writes disabled until TLS",
  peerLocal: "the request comes from this machine; answer from another device",
} as const;

/**
 * A class is set once, where the command is defined. Re-classing would let a wrapper turn an
 * owner-write into a read and drop its guard, so every class helper refuses an already-classed command.
 */
function assertUnclassed(command: { readonly name: string }, commandClass: CommandClass): void {
  if ("commandClass" in command) {
    throw new Error(`Console command ${command.name} is already classed; it cannot be re-classed as ${commandClass}`);
  }
}

/** The runtime half of `ServedWithoutOwner`, for a caller that cast its way past the types. */
function assertNotOwnerWrite(command: { readonly name: string }, commandClass: CommandClass): void {
  if ("ownerWrite" in command) {
    throw new Error(`Console command ${command.name} is an owner-write handler; it cannot be served as ${commandClass}, only through ownerWriteCommand`);
  }
}

/** Fails startup on a command with no class, or one outside the known classes, rather than serving it as a read. */
export function assertClassed(command: AnyCommand<ConsoleContext>): asserts command is ClassedCommand {
  const commandClass: unknown = (command as Partial<ClassedCommand>).commandClass;
  if (!COMMAND_CLASSES.includes(commandClass as CommandClass)) {
    throw new Error(`Console command ${command.name} has no class; define it with readCommand, depositCommand or ownerWriteCommand`);
  }
  if (commandClass !== "owner-write") assertNotOwnerWrite(command, commandClass as CommandClass);
}

/** Keeps the command's own args and result types, so `CommandMapOf` still types the browser's hooks. */
export function readCommand<Args, Result, Ctx extends BaseContext>(
  command: Command<Args, Result, Ctx> & ServedWithoutOwner<Ctx>,
): Command<Args, Result, Ctx> & { readonly commandClass: "read" } {
  assertUnclassed(command, "read");
  assertNotOwnerWrite(command, "read");
  return { ...command, commandClass: "read" };
}

/** `Ctx` is the handler's own context, inferred only so `ServedWithoutOwner` can check it. */
export function depositCommand<Ctx extends BaseContext>(command: AnyCommand<ConsoleContext> & AnyCommand<Ctx> & ServedWithoutOwner<Ctx>): ClassedCommand {
  assertUnclassed(command, "deposit");
  assertNotOwnerWrite(command, "deposit");
  return {
    ...command,
    commandClass: "deposit",
    run: (args, ctx: ConsoleContext) => {
      if (ctx.surface !== "http") throw new CommandRefusedError("deposit", REFUSALS.notHttp);
      return command.run(args, ctx);
    },
  };
}

export function ownerWriteCommand<Args, Result>(command: OwnerWriteHandler<Args, Result>): ClassedCommand {
  assertUnclassed(command, "owner-write");
  return {
    ...command,
    commandClass: "owner-write",
    run: (args: Args, ctx: ConsoleContext) => command.run(args, { ...ctx, ownerPresence: admitOwner(ctx) }),
  };
}

/** Returns the presence proof, or throws naming the first rule the request breaks. */
function admitOwner(ctx: ConsoleContext): OwnerPresence {
  const refuse = (reason: string): never => {
    throw new CommandRefusedError("owner-write", reason);
  };
  if (ctx.surface !== "http") refuse(REFUSALS.notHttp);
  const { auth } = ctx;
  if (auth === null) return refuse(REFUSALS.noCredential);
  if (auth.credential !== "session" || auth.issuedAt === null) return refuse(REFUSALS.bearer);
  if (!ctx.ownerWrites) refuse(REFUSALS.disabled);
  if (auth.peerLocal) refuse(REFUSALS.peerLocal);
  return { issuedAt: auth.issuedAt };
}
