import { useEffect, useRef, useState } from "react";
import { loadRunPackage, type LoadedRunReport, type RunPackageSnapshot } from "./RunReport.js";
import { SavedRunViewer } from "./SavedRunViewer.js";

export interface LiveRunViewerProps {
  readonly initialSnapshot: RunPackageSnapshot;
  readonly initialRun: LoadedRunReport | null;
}

type RunStatus = LoadedRunReport["status"];

const runStatus = (snapshot: RunPackageSnapshot): RunStatus | null => {
  const manifest = snapshot.manifest;
  if (typeof manifest !== "object" || manifest === null || !("status" in manifest)) return null;
  const status = manifest.status;
  return status === "partial" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
    ? status
    : null;
};

const fetchSnapshot = async (): Promise<RunPackageSnapshot> => {
  const response = await fetch("/__catanarchy/run-snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as RunPackageSnapshot;
};

export const LiveRunViewer = ({ initialSnapshot, initialRun }: LiveRunViewerProps) => {
  const [run, setRun] = useState(initialRun);
  const [status, setStatus] = useState<RunStatus | null>(() => runStatus(initialSnapshot));
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const [error, setError] = useState<string | null>(null);
  const snapshot = useRef(initialSnapshot);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    if (runStatus(snapshot.current) !== "partial") {
      return () => {
        active = false;
      };
    }
    const after = snapshot.current.records.length - 1;
    const source = new EventSource(`/__catanarchy/run-stream?after=${after}`);
    const updateStatus = (next: RunPackageSnapshot): void => {
      const nextStatus = runStatus(next);
      if (active) setStatus(nextStatus);
      if (nextStatus !== null && nextStatus !== "partial") source.close();
    };
    const publish = async (next: RunPackageSnapshot): Promise<void> => {
      const currentGeneration = generation.current + 1;
      generation.current = currentGeneration;
      snapshot.current = next;
      updateStatus(next);
      try {
        const loaded = await loadRunPackage(next);
        if (active && generation.current === currentGeneration) {
          setRun(loaded);
          setError(null);
        }
      } catch (cause) {
        if (active && generation.current === currentGeneration) {
          setError(cause instanceof Error ? cause.message : "Could not read the live run.");
        }
      }
    };
    const resync = async (): Promise<void> => {
      try {
        await publish(await fetchSnapshot());
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not reload the live run.");
        }
      }
    };
    source.onopen = () => {
      if (active) setConnection("live");
    };
    source.onerror = () => {
      if (active) setConnection("reconnecting");
    };
    source.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(event.data) as {
          readonly manifest: unknown;
          readonly record: unknown;
          readonly verification: unknown;
        };
        const record = message.record as { readonly index?: unknown };
        const expected = snapshot.current.records.length;
        if (typeof record.index === "number" && record.index < expected) return;
        if (record.index !== expected) {
          void resync();
          return;
        }
        void publish({
          manifest: message.manifest,
          records: [...snapshot.current.records, message.record],
          verification: message.verification,
        });
      } catch {
        void resync();
      }
    };
    source.addEventListener("manifest", (event) => {
      if (!active || !(event instanceof MessageEvent)) return;
      try {
        void publish({ ...snapshot.current, manifest: JSON.parse(event.data) });
      } catch {
        void resync();
      }
    });
    source.addEventListener("run-error", () => {
      if (active) setConnection("reconnecting");
    });
    return () => {
      active = false;
      source.close();
    };
  }, []);

  if (run === null) {
    const ended = status !== null && status !== "partial";
    return (
      <main className="waiting">
        <strong>
          {ended ? `The run ended with status: ${status}.` : "Waiting for the first game state."}
        </strong>
        {error === null || ended ? null : <p className="error">{error}</p>}
      </main>
    );
  }
  return (
    <>
      {connection === "reconnecting" ? (
        <div className="connection-warning">The live connection is reconnecting.</div>
      ) : null}
      <SavedRunViewer run={run} live />
    </>
  );
};
