/** The `code` of a thrown filesystem error, or undefined when the value carries none. */
export const errno = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);
