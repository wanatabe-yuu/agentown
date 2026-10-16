import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { DialogHost } from "./dialogs.tsx";
import { installPullToRefresh, watchForNewVersion } from "./refresh.ts";
import "./styles.css";

installPullToRefresh();
watchForNewVersion();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <DialogHost />
  </StrictMode>,
);
