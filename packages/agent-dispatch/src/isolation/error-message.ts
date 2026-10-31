/** What a caught value says; a rejection need not be an Error. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
