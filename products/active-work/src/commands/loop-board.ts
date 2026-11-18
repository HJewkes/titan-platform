import { z } from 'zod';
import { resolveLedgerPaths } from '../sessions/ledger-file.js';
import { LoopBoardSchema, loadBoard, type LoopBoard } from '../session-index/loop-board.js';
import { defineCommand } from '../registry/index.js';
import { visibilityFor, type Shown } from '../sessions/visibility.js';

const ArgsSchema = z.object({});

type Args = z.infer<typeof ArgsSchema>;

/** An agent sees no loop of an owner-only initiative, nor its id on a tree node; only the count (TP-5453 P6b). */
function boardFor(board: LoopBoard, visible: Shown): LoopBoard {
  const loops = board.loops.filter((loop) => visible(loop.initiative));
  const hidden = board.loops.length - loops.length;
  if (hidden === 0) return board;
  const kept = new Set(loops.map((loop) => loop.id));
  const tree = board.tree && {
    ...board.tree,
    nodes: board.tree.nodes.map((node) => ({ ...node, loops: node.loops.filter((id) => kept.has(id)) })),
  };
  const noun = hidden === 1 ? 'loop' : 'loops';
  return { ...board, loops, tree, warnings: [...board.warnings, `${hidden} ${noun} of owner-only initiatives hidden from a non-owner caller`] };
}

export default defineCommand<Args, LoopBoard>({
  name: 'loop.board',
  description:
    'The platform-wide loop board: every row of the open-loops ledger, the open session loops ' +
    'no ledger row claims (by linking their task), and the tech tree. Tiers are advisory: ' +
    'coordinators weigh them, nothing gates on them. Malformed rows are skipped and named in ' +
    '`warnings`. Write the ledger with `loop import` and `loop tier`, never by hand.',
  args: ArgsSchema,
  result: LoopBoardSchema,
  cli: { usage: 'active-work loop board [--json]' },
  async run(_args, ctx) {
    const paths = await resolveLedgerPaths(ctx.activeRoot);
    const [board, visible] = await Promise.all([
      loadBoard(ctx.activeRoot, paths, new Date()),
      visibilityFor(ctx),
    ]);
    return boardFor(board, visible);
  },
});
