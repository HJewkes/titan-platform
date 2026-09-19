import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcProvider } from "@titan-design/react-app";
import { App } from "./App.js";
import { reportDataSource } from "./data/source.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RpcProvider source={reportDataSource()}>
      <App />
    </RpcProvider>
  </StrictMode>,
);
