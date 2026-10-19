/** Bash rejects a subscripted name here as no valid identifier, so the variable keeps its value. */
export const SCALAR_DECLARERS = new Set(["export", "readonly"]);
/** An `r` in an option word, even one bash must still expand, may make every name the declaration lists readonly. */
export const READONLY_FLAG_RE = /^-.*r/s;
/** Bash reads options only up to `--` or the first word that is none. */
export const OPTION_WORD_RE = /^[-+]./s;
const DECLARE_LETTERS = new Set("airtx");
/**
 * The option letters that assign the value as written in bash 3.2 and 5 alike. Any other may assign nothing
 * (`-f` names a function, `-p` prints, bash 3.2 rejects `-g`, `-A`, `-n` and `-I`) or change the value (`-l`, `-u`).
 */
export const OPTION_LETTERS: Record<string, Set<string>> = {
  declare: DECLARE_LETTERS,
  typeset: DECLARE_LETTERS,
  local: DECLARE_LETTERS,
  export: new Set("n"),
  readonly: new Set("a"),
};
