import { z } from 'zod';
import { resolveLedgerPaths } from '../sessions/ledger-file.js';
import { LoopBoardSchema, loadBoard, type LoopBoard } from '../sessions/loop-board.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({});

type Args = z.infer<typeof ArgsSchema>;

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
    return loadBoard(ctx.activeRoot, paths, new Date());
  },
});
