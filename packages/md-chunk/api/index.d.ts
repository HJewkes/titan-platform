interface BlockRange {
    /** Byte offset of the block's first byte. */
    start: number;
    /** Byte offset just past the block; the range is half-open. */
    end: number;
    /** 1-based line of the block's first line. */
    startLine: number;
    /** 1-based line of the block's last line, inclusive. */
    endLine: number;
}
type Block = (BlockRange & {
    kind: "frontmatter" | "paragraph" | "table";
}) | (BlockRange & {
    kind: "heading";
    level: number;
    text: string;
}) | (BlockRange & {
    kind: "fence";
    closed: boolean;
});
type BlockKind = Block["kind"];
/**
 * Scans markdown into top-level blocks with byte and line ranges. Blank lines between
 * blocks belong to no block. Offsets index the UTF-8 encoding of `source`.
 */
declare function scanBlocks(source: string | Uint8Array): Block[];

export { type Block, type BlockKind, type BlockRange, scanBlocks };
