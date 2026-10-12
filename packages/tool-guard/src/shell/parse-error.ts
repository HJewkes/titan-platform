export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * A line with more than one reading, which is refused: bash 5 and bash 3.2 differ on a heredoc a
 * closed `$( )` or `<( )` left open, a `<( )` inside `${ }`, or a `$( )` inside `${ }` or `$(( ))`
 * that paren counting ends elsewhere; an unclosed substitution in a single-quoted span in `${ }`
 * is literal text unless double quotes around the `${ }` make bash run it; and bash may close a
 * `${ }`, `$(( ))` or `$[ ]` this reader cannot, failing only at expansion and running the rest.
 */
export type Split = "heredoc" | "procsub-brace" | "nested-substitution" | "quoted-substitution" | "unclosed-expansion";

export class SplitParseError extends ParseError {
  override name = "SplitParseError";

  constructor(
    message: string,
    readonly split: Split,
  ) {
    super(message);
  }
}

/** Runs `read`, refusing a plain ParseError from it as `split`, so a misread expansion denies rather than passes. */
export function refusingAs<T>(split: Split, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ParseError && !(error instanceof SplitParseError)) throw new SplitParseError(error.message, split);
    throw error;
  }
}
