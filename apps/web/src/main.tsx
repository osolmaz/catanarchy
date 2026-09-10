import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadRunReport } from "./RunReport.js";
import { SavedRunViewer } from "./SavedRunViewer.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The web application root element is missing.");
}

const runReportView = async (): Promise<ReactNode> => {
  const localPlayRequested = new URLSearchParams(window.location.search).get("mode") === "play";
  if (!__CATANARCHY_RUN_REPORT__ || localPlayRequested) return <App />;
  try {
    const response = await fetch("/__catanarchy/run-report");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return <SavedRunViewer run={await loadRunReport(await response.json())} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run-report error.";
    return (
      <main>
        <p className="error">Could not load the saved run: {message}</p>
      </main>
    );
  }
};

createRoot(root).render(<StrictMode>{await runReportView()}</StrictMode>);
