import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcProvider, pageDataSource } from "@titan-design/react-app";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RpcProvider source={pageDataSource()}>
      <App />
    </RpcProvider>
  </StrictMode>,
);
