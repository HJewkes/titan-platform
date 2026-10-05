const dropNul = (text: string): string => text.replaceAll("\0", "");

// zsh keeps NUL in the stream and ends a word's text at its first one; operators and quotes after it still parse.
const cutWordsAtNul = (text: string): string => text.replace(/\0[^\s;&|<>()'"`\\$]*/g, "");

/**
 * The readings of text piped into a shell. bash, sh and dash drop NUL (TP-1460); zsh cuts each word at it
 * (TP-1464). zsh and ksh get both, so a protected verdict from either reading stands if the cut model is wrong.
 */
export function pipedShellTexts(shell: string, stdin: string): string[] {
  if (!stdin.includes("\0")) return [stdin];
  if (shell === "zsh" || shell === "ksh") return [...new Set([dropNul(stdin), cutWordsAtNul(stdin)])];
  return [dropNul(stdin)];
}
