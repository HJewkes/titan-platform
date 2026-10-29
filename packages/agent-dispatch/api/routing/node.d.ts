import { PriorRouting, PriorRouter, TableRead } from './index.js';

/** The `shape-v1.yml` this package ships, with `needsOwns` on the size rows. */
declare const DEFAULT_WORKFLOW_TABLE: string;
declare const workflowTablePath: (autonomyRoot: string) => string;
/** `<autonomyRoot>/workflow/shape-v1.yml`, linted; undefined when the file is absent. */
declare function readWorkflowTable(autonomyRoot: string): TableRead | undefined;
/** The router for `mode`, or the one note saying why the dispatch routes as today; `off` touches no file. */
declare function readPriorRouter(mode: PriorRouting, autonomyRoot: string): {
    router?: PriorRouter;
    note?: string;
};

export { DEFAULT_WORKFLOW_TABLE, readPriorRouter, readWorkflowTable, workflowTablePath };
