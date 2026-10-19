import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";

/*
 * Stands in for react-ui's Page and PageHeader (titan-design TD-408), which are on titan-design main but in no
 * published react-ui yet. It keeps a subset of their props and their classes, so the swap is an import change and
 * this file goes. The console's document scrolls, so the page never adds a scroller of its own.
 */

export type PageMaxWidth = "narrow" | "wide" | "full";

interface PageProps {
  header?: ReactNode;
  children?: ReactNode;
  maxWidth?: PageMaxWidth;
  /** false: the page fills the region and the view owns its own scroll. */
  isScrollable?: boolean;
}

const MAX_WIDTH_CLASSES: Record<PageMaxWidth, string> = {
  narrow: "max-w-[760px] self-center",
  wide: "max-w-[1100px] self-center",
  full: "",
};

/** A view's content region: the gutter beside the rail, an optional width cap and a header slot. */
export function Page({ header, children, maxWidth = "full", isScrollable = true }: PageProps): ReactNode {
  const fill = isScrollable ? "" : " flex-1";
  return (
    <div role="main" className="flex min-w-0 flex-1 flex-col p-gutter-sm sm:p-gutter-md">
      <VStack gap={6} className={`w-full min-w-0 ${MAX_WIDTH_CLASSES[maxWidth]}${fill}`}>
        {header}
        <div className={`min-w-0${fill}`}>{children}</div>
      </VStack>
    </div>
  );
}

/** The page's level-1 heading. */
export function PageHeader({ title }: { title: string }): ReactNode {
  return (
    <Typography variant="h5" role="heading" aria-level={1} className="text-lg leading-tight sm:text-xl">
      {title}
    </Typography>
  );
}
