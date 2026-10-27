import { z } from "zod";
import { EXIT, defineCommand } from "@titan-design/registry";
import { failure, type ActiveWork } from "./active-work.js";
import { loopBoard, loopTierAnswer, loopTierArgs, type LoopBoard, type LoopTierArgs } from "./loop-board.js";
import type { ConsoleContext } from "./owner-guard.js";
import { keepsSlug, type WorkOptions } from "./work.js";

/** What the page says until the host's active-work daemon serves `loop.board`. */
export const OLD_DAEMON = "active-work ≥ 0.23 needed";

export const loopBoardResult = z.object({
  fetchedAt: z.string(),
  /** Null when the daemon cannot serve the board; `unavailable` then says why. */
  board: loopBoard.nullable(),
  unavailable: z.string().nullable(),
  /** Null when this caller may re-tier; otherwise the owner guard's refusal, shown on the page as the reason tiers are read-only. */
  tierWritesOff: z.string().nullable(),
});

type BoardRead = Omit<z.infer<typeof loopBoardResult>, "tierWritesOff">;

/** An old daemon answers the daemon package's unknown-command envelope, which the client rejects with a usage code. */
function isUnknownCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === EXIT.USAGE && error.message.includes("Unknown command: loop.board");
}

/** With personal initiatives excluded, their loops leave the board and the tree nodes that listed them. */
async function withoutPersonal(activeWork: ActiveWork, board: LoopBoard, options: WorkOptions): Promise<LoopBoard> {
  const keeps = await keepsSlug(activeWork, options);
  const loops = board.loops.filter((loop) => keeps(loop.initiative));
  const kept = new Set(loops.map((loop) => loop.id));
  const tree = board.tree && { ...board.tree, nodes: board.tree.nodes.map((node) => ({ ...node, loops: node.loops.filter((id) => kept.has(id)) })) };
  return { ...board, loops, tree };
}

/** The open-loops board. An old daemon reads as unavailable, never as an empty board; any other failure is the read's error. */
export async function readLoopBoard(activeWork: ActiveWork, options: WorkOptions = {}): Promise<BoardRead> {
  const fetchedAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    const board = await activeWork.read("loop.board");
    return { fetchedAt, board: options.excludePersonal ? await withoutPersonal(activeWork, board, options) : board, unavailable: null };
  } catch (error) {
    if (isUnknownCommand(error)) return { fetchedAt, board: null, unavailable: OLD_DAEMON };
    throw error;
  }
}

/** Re-tiers one loop in the ledger through active-work's `loop.tier`. */
export async function writeLoopTier(activeWork: ActiveWork, args: LoopTierArgs): Promise<z.infer<typeof loopTierAnswer>> {
  if (activeWork.write === undefined) throw failure("This active-work source takes no writes", EXIT.UNAVAILABLE);
  return activeWork.write("loop.tier", args);
}

/** `work.loop-tier` without its class; `commands.ts` registers it as the owner-write it is. */
export function loopTierCommand(activeWork: ActiveWork) {
  return defineCommand<LoopTierArgs, z.infer<typeof loopTierAnswer>, ConsoleContext>({
    name: "work.loop-tier",
    description: "Move one open loop to an advisory tier (S, A, B, C, parked or unsorted), optionally ahead of another loop, through active-work's loop.tier",
    args: loopTierArgs,
    result: loopTierAnswer,
    run: (args) => writeLoopTier(activeWork, args),
  });
}
