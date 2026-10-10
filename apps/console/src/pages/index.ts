import { createElement, type ReactNode } from "react";
import type { Route, ViewKey } from "../router.js";
import { HomePage } from "./HomePage.js";
import { InitiativeDetailPage } from "./InitiativeDetailPage.js";
import { InitiativesPage } from "./InitiativesPage.js";
import { SessionsRoute } from "./SessionsPage.js";

type PageComponent = (props: { route: Route }) => ReactNode;

const WorkPage: PageComponent = ({ route }) => (route.id ? createElement(InitiativeDetailPage, { slug: route.id }) : createElement(InitiativesPage));

/** One entry per built view; a rail entry with none here renders its placeholder. */
export const PAGES: Partial<Record<ViewKey, PageComponent>> = {
  home: HomePage,
  initiatives: WorkPage,
  sessions: SessionsRoute,
};
