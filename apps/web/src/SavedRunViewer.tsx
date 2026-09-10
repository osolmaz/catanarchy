import { observe } from "@catanarchy/engine";
import { useEffect, useState } from "react";
import { AgentTracePanel } from "./AgentTracePanel.js";
import { Board } from "./Board.js";
import { NegotiationTimeline } from "./NegotiationTimeline.js";
import type { LoadedRunReport, RunTrace } from "./RunReport.js";

export interface SavedRunViewerProps {
  readonly run: LoadedRunReport;
}

const gameTraceVisible = (trace: RunTrace, gameSequence: number): boolean =>
  trace.sequence !== undefined && trace.sequence < gameSequence;

const negotiationTraceVisible = (trace: RunTrace, gameSequence: number): boolean =>
  trace.gameSequence !== undefined && trace.gameSequence < gameSequence;

const playbackLabel = (source: LoadedRunReport["timingSource"]): string => {
  switch (source) {
    case "recorded-model-time":
      return "Recorded model time";
    case "mixed":
      return "Recorded model time with 1-second gaps";
    case "synthetic":
      return "Synthetic 1 second per command";
  }
};

export const SavedRunViewer = ({ run }: SavedRunViewerProps) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const latestIndex = run.states.length - 1;
  const state = run.states[frameIndex] ?? run.state;
  const observation = observe(state, { type: "public" });
  const visibleEvents = run.events.filter(({ sequence }) => sequence <= state.sequence);
  const visibleDecisions = run.decisions.filter((trace) => gameTraceVisible(trace, state.sequence));
  const visibleNegotiationDecisions = run.negotiationDecisions.filter((trace) =>
    negotiationTraceVisible(trace, state.sequence),
  );
  const visibleNegotiation = {
    ...run.negotiation,
    events: run.negotiation.events.filter(({ gameSequence }) => gameSequence < state.sequence),
  };

  useEffect(() => {
    if (!playing || frameIndex >= latestIndex) return;
    const duration = run.frameDurationsMs[frameIndex] ?? 1_000;
    const timer = setTimeout(() => {
      setFrameIndex((current) => current + 1);
      if (frameIndex + 1 >= latestIndex) setPlaying(false);
    }, duration / speed);
    return () => clearTimeout(timer);
  }, [frameIndex, latestIndex, playing, run.frameDurationsMs, speed]);

  const seek = (index: number): void => {
    setPlaying(false);
    setFrameIndex(index);
  };

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">Catanarchy saved agent run</p>
          <h1>Replay {run.state.matchId}</h1>
          <p className="subtitle">
            Step through the complete saved game, negotiation, and model-call traces.
          </p>
        </div>
        <a className="viewer-link" href="?mode=play">
          Play a new game
        </a>
      </header>

      <section className="status-card" aria-live="polite">
        <div>
          <span>Match</span>
          <strong>{state.matchId}</strong>
        </div>
        <div>
          <span>Replay frame</span>
          <strong>
            {frameIndex + 1} of {run.states.length}
          </strong>
        </div>
        <div>
          <span>Game sequence</span>
          <strong>{state.sequence}</strong>
        </div>
        <div className="phase-status">
          <span>Phase</span>
          <strong>{state.phase.tag}</strong>
        </div>
      </section>

      <section className="game-grid">
        <div className="board-panel">
          <Board
            observation={observation}
            legalActions={[]}
            onAction={() => {}}
            interactive={false}
          />
          <div className="replay-controls" aria-label="Saved run replay controls">
            <button type="button" disabled={frameIndex === 0} onClick={() => seek(0)}>
              First
            </button>
            <button type="button" disabled={frameIndex === 0} onClick={() => seek(frameIndex - 1)}>
              Previous
            </button>
            <button
              type="button"
              disabled={frameIndex === latestIndex}
              onClick={() => setPlaying((current) => !current)}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              disabled={frameIndex === latestIndex}
              onClick={() => seek(frameIndex + 1)}
            >
              Next
            </button>
            <button
              type="button"
              disabled={frameIndex === latestIndex}
              onClick={() => seek(latestIndex)}
            >
              Last
            </button>
            <label>
              Speed
              <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={5}>5×</option>
                <option value={10}>10×</option>
                <option value={20}>20×</option>
              </select>
            </label>
            <small>{playbackLabel(run.timingSource)}</small>
          </div>
        </div>

        <aside>
          <section className="panel">
            <h2>Negotiation</h2>
            <NegotiationTimeline negotiation={visibleNegotiation} gameEvents={visibleEvents} />
          </section>

          <section className="panel">
            <h2>Agent sessions and decisions</h2>
            <AgentTracePanel
              decisions={visibleDecisions}
              negotiationDecisions={visibleNegotiationDecisions}
            />
          </section>

          <section className="panel">
            <h2>Event log</h2>
            <ol className="events">
              {run.events.map((event) => (
                <li
                  key={`${event.sequence}:${event.event.type}`}
                  className={event.sequence <= state.sequence ? "visible" : "future"}
                >
                  <code>{event.sequence}</code>
                  <span>{event.event.type}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </section>
    </main>
  );
};
