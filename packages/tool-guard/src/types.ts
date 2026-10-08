import type { SimpleCommand } from "./shell/commands.js";
import type { ReadEvent, WriteEvent } from "./event.js";
import type { SpellingId } from "./spellings.js";

/** What the host knows. The filesystem arrives as a port so the classifier stays pure. */
export interface ClassifyContext {
  home: string;
  /** Realpath of an existing path, null when it does not exist. */
  readLink(path: string): string | null;
  /** Current branch of the checkout at `dir`, null when detached or not a checkout. */
  readHead(dir: string): string | null;
  /** Text of a script run by path, null when it cannot be read. */
  readScript(path: string): string | null;
  /** Whether a PATH lookup finds a program whatever the case of its name, so `GIT push` runs git. */
  foldCase?: boolean;
}

export type GuardedAction = "merge" | "release" | "secret-read" | "authority-config" | "private-egress";

/** What an event would do, with no actor attached. */
export interface ClassifiedAction {
  action: GuardedAction;
  spelling: SpellingId;
  /** Safe fields only: a guarded pattern id, never the path the agent typed. */
  subject: Record<string, string>;
  remedy: string;
}

/** One family of classified spellings. `classify.ts` holds the registry. */
export interface Family {
  /** Command names `bash` sees; omitted means every command, including ones with no static name. */
  names?: ReadonlySet<string>;
  /**
   * For a family that sees every command, the names it reads differently from the rest: those it adds a verdict for and
   * those whose arguments it exempts. Build it from the same sets `bash` checks, so the two cannot drift apart.
   */
  verbs?: ReadonlySet<string>;
  bash?(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[];
  read?(event: ReadEvent, ctx: ClassifyContext): ClassifiedAction[];
  write?(event: WriteEvent, ctx: ClassifyContext): ClassifiedAction[];
  /** The context later commands on the same line see, when `cmd` changes it; undefined leaves it as it is. */
  after?(cmd: SimpleCommand, ctx: ClassifyContext): ClassifyContext | undefined;
}
