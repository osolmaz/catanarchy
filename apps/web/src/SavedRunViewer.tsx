import { observe } from "@catanarchy/engine";
import { AgentTracePanel } from "./AgentTracePanel.js";
import { Board } from "./Board.js";
import { NegotiationTimeline } from "./NegotiationTimeline.js";
import type { LoadedRunReport } from "./RunReport.js";

export interface SavedRunViewerProps {
  readonly run: LoadedRunReport;
}

export const SavedRunViewer = ({ run }: SavedRunViewerProps) => {
  const observation = observe(run.state, { type: "public" });
  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">Catanarchy saved agent run</p>
          <h1>Inspect {run.state.matchId}</h1>
          <p className="subtitle">
            This trusted local report shows the final board, negotiation, and saved model-call
            traces.
          </p>
        </div>
      </header>

      <section className="status-card" aria-live="polite">
        <div>
          <span>Match</span>
          <strong>{run.state.matchId}</strong>
        </div>
        <div>
          <span>Event sequence</span>
          <strong>{run.state.sequence}</strong>
        </div>
        <div className="phase-status">
          <span>Final phase</span>
          <strong>{run.state.phase.tag}</strong>
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
        </div>

        <aside>
          <section className="panel">
            <h2>Negotiation</h2>
            <NegotiationTimeline
              negotiation={run.negotiation}
              gameEvents={run.events}
              throughGameSequence={run.state.sequence}
            />
          </section>

          <section className="panel">
            <h2>Agent sessions and decisions</h2>
            <AgentTracePanel
              decisions={run.decisions}
              negotiationDecisions={run.negotiationDecisions}
            />
          </section>

          <section className="panel">
            <h2>Event log</h2>
            <ol className="events">
              {run.events.map((event) => (
                <li key={`${event.sequence}:${event.event.type}`} className="visible">
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
