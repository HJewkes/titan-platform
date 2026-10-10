export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * A line with more than one reading, which is refused: bash 5 and bash 3.2 differ on a heredoc a
 * closed `$( )` or `<( )` left open, a `<( )` inside `${ }`, or a `$( )` inside `${ }` or `$(( ))`
 * that paren counting ends elsewhere; and an unclosed substitution in a single-quoted span in `${ }`
 * is literal text unless double quotes around the `${ }` make bash run it.
 */
export type Split = "heredoc" | "procsub-brace" | "nested-substitution" | "quoted-substitution";

export class SplitParseError extends ParseError {
  override name = "SplitParseError";

  constructor(
    message: string,
    readonly split: Split,
  ) {
    super(message);
  }
}
