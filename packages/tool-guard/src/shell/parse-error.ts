export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * What bash 5 and bash 3.2 read differently: a heredoc a closed `$( )` or `<( )` left open, a `<( )`
 * inside `${ }`, or a `$( )` inside `${ }` or `$(( ))` that paren counting ends elsewhere.
 */
export type Split = "heredoc" | "procsub-brace" | "nested-substitution";

export class SplitParseError extends ParseError {
  override name = "SplitParseError";

  constructor(
    message: string,
    readonly split: Split,
  ) {
    super(message);
  }
}
