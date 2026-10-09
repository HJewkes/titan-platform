import { sameSpend } from "./arith-trials.js";
import { type LexState, scanSubstitutions, SplitParseError } from "./lexer.js";

/**
 * A heredoc still open when a `$( )` or `<( )` closes takes its body from the lines after this one in bash 5,
 * which also moves the bodies of the line's own heredocs further down; bash 3.2 runs those lines as commands.
 * Every partial model of bash 5's reading has left some text it runs unchecked, so the line is refused.
 */
export function readLineEnd(s: LexState): void {
  if (s.leftOpen) throw new SplitParseError("a heredoc left open by a substitution is read differently by bash 5 and bash 3.2");
  readHeredocBodies(s);
}

function readHeredocBodies(s: LexState): void {
  for (const { token, stripTabs } of s.heredocs) {
    const delim = token.target?.value;
    let body = "";
    while (s.i < s.src.length) {
      const newline = s.src.indexOf("\n", s.i);
      const end = newline === -1 ? s.src.length : newline;
      const line = stripTabs ? s.src.slice(s.i, end).replace(/^\t+/, "") : s.src.slice(s.i, end);
      s.i = end + 1;
      if (line === delim) break;
      body += `${line}\n`;
    }
    token.body = body;
    if (!token.target?.quoted) token.subs = scanSubstitutions(body, 0, body.length, sameSpend(s.trials));
  }
  s.heredocs = [];
}
