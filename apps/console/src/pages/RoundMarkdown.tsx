import type { ReactNode } from "react";
import { MarkdownProse, type ProseLinker } from "@titan-design/react-ui";

/**
 * Round text as markdown (TP-3768). react-ui 0.20's `MarkdownProse` knows headings, bullets, bold and code but
 * not `[text](url)`, has no inline mode and no URL policy, so links come in through its linkers and the inline
 * half lives here until react-ui grows both. Inline links are plain anchors: react-ui 0.20's `Link` is a block
 * view, which would break a prompt's line. Only http(s), mailto and relative targets link; anything else,
 * `javascript:` included, shows its text and links nowhere.
 */
const SAFE_LINK = /\[[^\]\n]+\]\((?:(?:https?:\/\/|mailto:)[^()\s]*|[^():\s]+)\)/;
/** Any other link target, one level of parentheses included, so `javascript:alert(1)` is caught whole. */
const ANY_LINK = /\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))*\)/;
const BOLD = /\*\*[^*]+\*\*/;
const CODE = /`[^`]+`/;
const INLINE = new RegExp(`(${[BOLD, CODE, SAFE_LINK, ANY_LINK].map((pattern) => pattern.source).join("|")})`, "g");
const whole = (pattern: RegExp): RegExp => new RegExp(`^(?:${pattern.source})$`);

const linkText = (ref: string): string => ref.slice(1, ref.indexOf("]("));
const linkTarget = (ref: string): string => ref.slice(ref.indexOf("](") + 2, -1);
const openTarget = (ref: string): void => {
  window.open(linkTarget(ref), "_blank", "noopener");
};

/** The safe link is listed first, so a target both patterns match links; one only `ANY_LINK` matches stays text. */
const LINKERS: ProseLinker[] = [
  { id: "round-link", pattern: SAFE_LINK, tone: "link", label: linkText, onPress: openTarget },
  { id: "round-link-refused", pattern: ANY_LINK, tone: "muted", label: linkText },
];

/** A block of round text: context, a section's notes, a recommendation's rationale. */
export function RoundProse({ text, testID }: { text: string; testID?: string }): ReactNode {
  return <MarkdownProse body={text} linkers={LINKERS} testID={testID} />;
}

const KINDS = [
  ["bold", whole(BOLD)],
  ["code", whole(CODE)],
  ["link", whole(SAFE_LINK)],
  ["refused", whole(ANY_LINK)],
] as const;

type Kind = (typeof KINDS)[number][0] | "text";

const kindOf = (piece: string): Kind => KINDS.find(([, pattern]) => pattern.test(piece))?.[0] ?? "text";
const piecesOf = (text: string): string[] => text.split(INLINE).filter((piece) => piece !== "");

/** A piece's words with its markup dropped. */
function wordsOf(piece: string, kind: Kind): string {
  if (kind === "bold") return piece.slice(2, -2);
  if (kind === "code") return piece.slice(1, -1);
  return kind === "text" ? piece : linkText(piece);
}

function inlinePiece(piece: string, index: number): ReactNode {
  const kind = kindOf(piece);
  if (kind === "bold") return <strong key={index}>{wordsOf(piece, kind)}</strong>;
  if (kind === "code") return <code key={index} className="font-mono">{wordsOf(piece, kind)}</code>;
  if (kind === "link") {
    return (
      <a key={index} href={linkTarget(piece)} target="_blank" rel="noopener noreferrer" className="text-text-link underline">
        {linkText(piece)}
      </a>
    );
  }
  return wordsOf(piece, kind);
}

/** One line of round text inside the caller's own typography: a prompt or an option. Plain text comes back unchanged. */
export function InlineMarkdown({ text }: { text: string }): ReactNode {
  const pieces = piecesOf(text);
  return pieces.every((piece) => kindOf(piece) === "text") ? text : pieces.map(inlinePiece);
}

/** A line of round text with its markup dropped, for a label that takes only a string. */
export const plainText = (text: string): string => piecesOf(text).map((piece) => wordsOf(piece, kindOf(piece))).join("");
