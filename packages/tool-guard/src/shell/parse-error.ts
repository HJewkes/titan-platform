export class ParseError extends Error {
  override name = "ParseError";
}

/** What bash 5 and bash 3.2 read differently: a heredoc a closed `$( )` or `<( )` left open, or a `}` inside a `<( )` in `${ }`. */
export type Split = "heredoc" | "procsub-brace";

export class SplitParseError extends ParseError {
  override name = "SplitParseError";

  constructor(
    message: string,
    readonly split: Split,
  ) {
    super(message);
  }
}
