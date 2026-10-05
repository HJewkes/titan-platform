const dropNul = (text: string): string => text.replaceAll("\0", "");

// zsh keeps NUL in the stream and ends each blank-delimited word at its first one.
const cutWordsAtNul = (text: string): string => text.replace(/[^\s\0]*\0\S*/g, (word) => word.slice(0, word.indexOf("\0")));

/**
 * The readings of text piped into a shell. bash, sh and dash drop NUL (TP-1460); zsh cuts each word at it
 * (TP-1464). ksh is not certain, so it gets both and a protected verdict from either one stands.
 */
export function pipedShellTexts(shell: string, stdin: string): string[] {
  if (!stdin.includes("\0")) return [stdin];
  if (shell === "zsh") return [cutWordsAtNul(stdin)];
  if (shell === "ksh") return [...new Set([dropNul(stdin), cutWordsAtNul(stdin)])];
  return [dropNul(stdin)];
}
