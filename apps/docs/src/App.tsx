import { Page, PageHeader, Paragraph } from "@titan-design/react-ui";
import type { ReactNode } from "react";
import { DocsShell } from "./DocsShell.js";

/** The routes the prerender writes; "" is the site root. */
export const ROUTES = [""] as const;
export type Route = (typeof ROUTES)[number];

function PreviewPage() {
  return (
    <Page header={<PageHeader title="Docs preview" description="The titan-platform docs, rendered with react-ui." />}>
      <Paragraph>This page is prerendered to static HTML and hydrated in the browser. Guide pages follow.</Paragraph>
    </Page>
  );
}

const PAGES: Record<Route, () => ReactNode> = { "": PreviewPage };

/** The only place a route is read: the server renders each one, and the client hydrates the one its page names. */
export function App({ route }: { route: Route }) {
  const Body = PAGES[route];
  return (
    <DocsShell>
      <Body />
    </DocsShell>
  );
}
