import type { RunTrace } from "./RunReport.js";

const modelText = (trace: RunTrace): string =>
  trace.model === undefined
    ? "scripted or fallback"
    : `${trace.model.provider}/${trace.model.modelId}`;

const actionText = (trace: RunTrace): string =>
  trace.actionId ?? trace.actionType ?? trace.failure ?? "no selection";

const usageText = (trace: RunTrace): string =>
  trace.usage === undefined
    ? "usage unavailable"
    : `${trace.usage.total.toLocaleString()} tokens · $${trace.usage.cost.toFixed(6)}`;

interface SessionSummary {
  readonly playerId: string;
  readonly model: string;
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

const emptySession = (trace: RunTrace): SessionSummary => ({
  playerId: trace.playerId,
  model: modelText(trace),
  calls: 0,
  tokens: 0,
  cost: 0,
});

const addTrace = (session: SessionSummary, trace: RunTrace): SessionSummary => ({
  ...session,
  model: trace.model === undefined ? session.model : modelText(trace),
  calls: session.calls + (trace.outcome === "failed" ? 0 : 1),
  tokens: session.tokens + (trace.usage?.total ?? 0),
  cost: session.cost + (trace.usage?.cost ?? 0),
});

const summarizeSessions = (traces: ReadonlyArray<RunTrace>): ReadonlyArray<SessionSummary> => {
  const sessions = new Map<string, SessionSummary>();
  for (const trace of traces) {
    const current = sessions.get(trace.playerId) ?? emptySession(trace);
    sessions.set(trace.playerId, addTrace(current, trace));
  }
  return [...sessions.values()];
};

const traceSequence = (trace: RunTrace): string =>
  trace.sequence === undefined ? `game ${trace.gameSequence ?? "?"}` : `game ${trace.sequence}`;

interface TraceListProps {
  readonly label: string;
  readonly traces: ReadonlyArray<RunTrace>;
}

const TraceList = ({ label, traces }: TraceListProps) => (
  <>
    <h3>{label}</h3>
    {traces.length === 0 ? (
      <p className="timeline-empty">No records.</p>
    ) : (
      <ol className="agent-traces" aria-label={label}>
        {traces.map((trace, index) => (
          <li key={`${label}:${traceSequence(trace)}:${trace.playerId}:${trace.attempt}:${index}`}>
            <div>
              <strong>{trace.playerId}</strong>
              <span className={`trace-outcome ${trace.outcome}`}>{trace.outcome}</span>
              <code>{actionText(trace)}</code>
            </div>
            <small>
              {traceSequence(trace)} · attempt {trace.attempt} · {modelText(trace)} ·{" "}
              {usageText(trace)}
              {trace.selectionMode === undefined ? "" : ` · ${trace.selectionMode}`}
              {` · ${Math.round(trace.elapsedMs)} ms`}
            </small>
            {trace.reason === undefined ? null : <p>{trace.reason}</p>}
          </li>
        ))}
      </ol>
    )}
  </>
);

export interface AgentTracePanelProps {
  readonly decisions: ReadonlyArray<RunTrace>;
  readonly negotiationDecisions: ReadonlyArray<RunTrace>;
}

export const AgentTracePanel = ({ decisions, negotiationDecisions }: AgentTracePanelProps) => {
  const allTraces = [...decisions, ...negotiationDecisions];
  const sessions = summarizeSessions(allTraces);
  return (
    <>
      <p className="session-note">
        Pi sessions were in memory and were disposed after the run. Raw Pi message history was not
        saved. The records below are the saved model calls, tool selections, reasons, timing, token
        use, and cost.
      </p>
      <h3>Seat sessions</h3>
      <div className="session-summaries">
        {sessions.map((session) => (
          <article key={session.playerId}>
            <strong>{session.playerId}</strong>
            <span>{session.model}</span>
            <small>
              {session.calls} calls · {session.tokens.toLocaleString()} tokens · $
              {session.cost.toFixed(6)}
            </small>
          </article>
        ))}
      </div>
      <TraceList label="Game decisions" traces={decisions} />
      <TraceList label="Negotiation decisions" traces={negotiationDecisions} />
    </>
  );
};
