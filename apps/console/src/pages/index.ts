import { createElement, type ReactNode } from "react";
import type { Route, ViewKey } from "../router.js";
import { HomePage } from "./HomePage.js";
import { InitiativeDetailPage } from "./InitiativeDetailPage.js";
import { InitiativesPage } from "./InitiativesPage.js";
import { RoundDetailPage } from "./RoundDetailPage.js";
import { RoundsPage } from "./RoundsPage.js";
import { SessionsRoute } from "./SessionsPage.js";
import { TaskDetailPage } from "./TaskDetailPage.js";
import { TasksPage } from "./TasksPage.js";

type PageComponent = (props: { route: Route }) => ReactNode;

const WorkPage: PageComponent = ({ route }) => (route.id ? createElement(InitiativeDetailPage, { slug: route.id }) : createElement(InitiativesPage));
const RoundsView: PageComponent = ({ route }) => (route.id ? createElement(RoundDetailPage, { id: route.id }) : createElement(RoundsPage));

/** One entry per built view; a rail entry with none here renders its placeholder. */
export const PAGES: Partial<Record<ViewKey, PageComponent>> = {
  home: HomePage,
  initiatives: WorkPage,
  tasks: ({ route }) => (route.id ? createElement(TaskDetailPage, { id: route.id }) : createElement(TasksPage, { query: route.query })),
  sessions: SessionsRoute,
  rounds: RoundsView,
};
