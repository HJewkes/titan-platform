/** Command name to its args and result: the only type a client needs to be fully typed. */
export type CommandMap = Record<string, { args: unknown; result: unknown }>;
