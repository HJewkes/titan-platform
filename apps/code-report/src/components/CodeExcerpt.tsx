import type { ReactNode } from "react";
import type { SourceExcerpt as Excerpt } from "@titan-design/code-read/query";

function isHighlighted(line: number, excerpt: Excerpt): boolean {
  return excerpt.highlights.some((h) => line >= h.startLine && line <= h.endLine);
}

/** SEAM (TD-31): plain numbered lines until titan-design's code viewer with range highlighting lands. */
export function CodeExcerpt({ excerpt }: { excerpt: Excerpt }): ReactNode {
  const lines = excerpt.text.split("\n");
  return (
    <figure className="overflow-x-auto rounded border border-hairline">
      <figcaption className="border-b border-hairline px-2 py-1 text-xs text-text-secondary">
        {excerpt.path}, lines {excerpt.startLine} to {excerpt.endLine} ({excerpt.origin})
        {excerpt.truncated && ", cut at the excerpt line cap"}
      </figcaption>
      <pre className="m-0 p-0 font-mono text-xs leading-5">
        {lines.map((text, i) => {
          const line = excerpt.startLine + i;
          const marked = isHighlighted(line, excerpt);
          return (
            <div key={line} data-highlighted={marked || undefined} className={marked ? "bg-status-warning-subtle" : undefined}>
              <span className="inline-block w-12 select-none pr-3 text-right text-text-tertiary">{line}</span>
              {text}
            </div>
          );
        })}
      </pre>
    </figure>
  );
}
