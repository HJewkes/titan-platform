import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import type { Section } from "../../server/round-schema.js";
import { InlineMarkdown } from "./RoundMarkdown.js";

type Part = NonNullable<Section["parts"]>[number];

/** What the Current pane shows for a part that adds something, as the harness's did. */
const NO_CURRENT = "none (new)";

function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  return (
    <pre className="overflow-x-auto rounded bg-surface-raised p-2 text-sm">
      <code className={lang ? `font-mono language-${lang}` : "font-mono"}>{code}</code>
    </pre>
  );
}

function CodePane({ heading, code, lang }: { heading: "Current" | "Proposed"; code: string; lang?: string }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`part-pane-${heading.toLowerCase()}`}>
      <Typography variant="overline" color="secondary">{heading}</Typography>
      <CodeBlock code={code} lang={lang} />
    </div>
  );
}

function PartHeading({ part }: { part: Part }): ReactNode {
  return (
    <Typography variant="subtitle2">
      <strong>{part.id}</strong> · <InlineMarkdown text={part.label} />
    </Typography>
  );
}

/** One part the owner decides: what it is now beside what it would become, stacked on a phone. */
function OpenPart({ part }: { part: Part }): ReactNode {
  return (
    <VStack gap={1} testID={`part-${part.id}`}>
      <PartHeading part={part} />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <CodePane heading="Current" code={part.current ?? NO_CURRENT} lang={part.lang} />
        <CodePane heading="Proposed" code={part.proposed} lang={part.lang} />
      </div>
    </VStack>
  );
}

/** The parts the author settled, folded away with the cite that settles each. */
function SettledParts({ parts }: { parts: readonly Part[] }): ReactNode {
  return (
    <details data-testid="settled-parts">
      <summary className="cursor-pointer">
        <Typography variant="caption" color="secondary">{`${parts.length} settled ${parts.length === 1 ? "part" : "parts"}, FYI`}</Typography>
      </summary>
      <VStack gap={2}>
        {parts.map((part) => (
          <VStack key={part.id} gap={1} testID={`part-${part.id}`}>
            <PartHeading part={part} />
            <CodeBlock code={part.proposed} lang={part.lang} />
            <Typography variant="caption" color="secondary">
              Cite: <InlineMarkdown text={part.settled?.cite ?? ""} />
            </Typography>
          </VStack>
        ))}
      </VStack>
    </details>
  );
}

/** A section's parts: each unsettled one as Current | Proposed panes, the settled ones in one folded list. */
export function SectionParts({ parts }: { parts?: readonly Part[] }): ReactNode {
  if (!parts?.length) return null;
  const settled = parts.filter((part) => part.settled);
  return (
    <VStack gap={3} testID="section-parts">
      {parts.filter((part) => !part.settled).map((part) => <OpenPart key={part.id} part={part} />)}
      {settled.length > 0 ? <SettledParts parts={settled} /> : null}
    </VStack>
  );
}
