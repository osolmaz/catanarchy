import type { FeedItem } from "./Feed.js";
import type { RunTrace } from "./RunReport.js";

const modelText = (trace: RunTrace): string =>
  trace.model === undefined
    ? "scripted"
    : (trace.model.modelId.split("/").at(-1) ?? trace.model.modelId);

const actionText = (trace: RunTrace): string =>
  trace.actionId ?? trace.actionType ?? trace.failure ?? "no selection";

const money = (cost: number): string => `$${cost.toFixed(4)}`;

const usageText = (trace: RunTrace): string =>
  trace.usage === undefined
    ? ""
    : ` · ${trace.usage.total.toLocaleString()} tok · ${money(trace.usage.cost)}`;

const traceSequence = (trace: RunTrace): number => trace.sequence ?? trace.gameSequence ?? 0;

const outcomeText = (trace: RunTrace): string =>
  trace.outcome === "selected" ? "" : ` (${trace.outcome})`;

const metaText = (trace: RunTrace): string =>
  `${modelText(trace)}${usageText(trace)} · ${Math.round(trace.elapsedMs)} ms${trace.attempt > 1 ? ` · attempt ${trace.attempt}` : ""}`;

/** Saved model calls as feed items, so decisions interleave with the game they drove. */
export const decisionFeedItems = (
  traces: ReadonlyArray<RunTrace>,
  group: string,
): ReadonlyArray<FeedItem> =>
  traces.map((trace, index) => ({
    key: `${group}:${index}`,
    sequence: traceSequence(trace),
    order: -traces.length + index,
    kind: trace.outcome,
    text: `${trace.playerId}: ${actionText(trace)}${outcomeText(trace)}`,
    ...(trace.reason === undefined ? {} : { detail: trace.reason }),
    meta: metaText(trace),
  }));

export interface SessionSummary {
  readonly model: string;
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

const EMPTY_SESSION: SessionSummary = { model: "", calls: 0, tokens: 0, cost: 0 };

const addTrace = (session: SessionSummary, trace: RunTrace): SessionSummary => ({
  model: trace.model === undefined ? session.model : modelText(trace),
  calls: session.calls + (trace.outcome === "failed" ? 0 : 1),
  tokens: session.tokens + (trace.usage?.total ?? 0),
  cost: session.cost + (trace.usage?.cost ?? 0),
});

/** Per-seat totals across every saved model call. */
export const sessionSummaries = (
  traces: ReadonlyArray<RunTrace>,
): ReadonlyMap<string, SessionSummary> => {
  const sessions = new Map<string, SessionSummary>();
  for (const trace of traces) {
    sessions.set(trace.playerId, addTrace(sessions.get(trace.playerId) ?? EMPTY_SESSION, trace));
  }
  return sessions;
};

export const sessionText = (session: SessionSummary | undefined): string =>
  session === undefined
    ? ""
    : `${session.model || "scripted"} · ${session.calls} calls · ${session.tokens.toLocaleString()} tok · ${money(session.cost)}`;
