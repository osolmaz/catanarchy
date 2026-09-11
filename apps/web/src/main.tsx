import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { LiveRunViewer } from "./LiveRunViewer.js";
import {
  loadRunPackage,
  loadRunReport,
  type LoadedRunReport,
  type RunPackageSnapshot,
} from "./RunReport.js";
import { SavedRunViewer } from "./SavedRunViewer.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The web application root element is missing.");
}

const fetchJson = async (path: string): Promise<unknown> => {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

type LoadingReporter = (message: string) => Promise<void>;

const LoadingRun = ({ message }: { readonly message: string }) => (
  <main className="run-loading" aria-live="polite">
    <span className="loading-spinner" aria-hidden="true" />
    <strong>{message}</strong>
  </main>
);

const runView = async (reportLoading: LoadingReporter): Promise<ReactNode> => {
  const localPlayRequested = new URLSearchParams(window.location.search).get("mode") === "play";
  if (__CATANARCHY_RUN_SOURCE__ === null || localPlayRequested) return <App />;
  try {
    if (__CATANARCHY_RUN_SOURCE__ === "report") {
      await reportLoading("Loading saved run…");
      const report = await fetchJson("/__catanarchy/run-report");
      await reportLoading("Replaying saved run…");
      return <SavedRunViewer run={await loadRunReport(report)} />;
    }
    await reportLoading("Downloading recorded game…");
    const snapshot = (await fetchJson("/__catanarchy/run-snapshot")) as RunPackageSnapshot;
    await reportLoading(`Replaying ${snapshot.records.length.toLocaleString()} records…`);
    let initialRun: LoadedRunReport | null = null;
    try {
      initialRun = await loadRunPackage(snapshot);
    } catch {
      // A new live run can exist before its first game command is complete.
    }
    return <LiveRunViewer initialSnapshot={snapshot} initialRun={initialRun} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run error.";
    return (
      <main>
        <p className="error">Could not load the run: {message}</p>
      </main>
    );
  }
};

const application = createRoot(root);
const renderView = (view: ReactNode): void => {
  application.render(<StrictMode>{view}</StrictMode>);
};
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
const reportLoading = async (message: string): Promise<void> => {
  renderView(<LoadingRun message={message} />);
  await nextPaint();
};
renderView(<LoadingRun message="Opening replay…" />);
void runView(reportLoading).then(renderView);
