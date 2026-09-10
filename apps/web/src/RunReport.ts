import { replay } from "@catanarchy/engine";
import type {
  GameEvent,
  GameState,
  NegotiationEvent,
  NegotiationPromise,
  NegotiationView,
  PromiseEvidence,
  TradeOffer,
} from "@catanarchy/protocol";
import { Effect } from "effect";

export interface RunTrace {
  readonly sequence?: number;
  readonly gameSequence?: number;
  readonly playerId: string;
  readonly round?: number;
  readonly attempt: number;
  readonly outcome: "selected" | "failed" | "fallback";
  readonly actionId?: string;
  readonly actionType?: string;
  readonly reason?: string;
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly elapsedMs: number;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    readonly cost: number;
  };
  readonly selectionMode?: "tool" | "text";
  readonly failure?: string;
}

export interface LoadedRunReport {
  readonly state: GameState;
  readonly states: ReadonlyArray<GameState>;
  readonly frameDurationsMs: ReadonlyArray<number>;
  readonly timingSource: "recorded-model-time" | "mixed" | "synthetic";
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiation: NegotiationView;
  readonly decisions: ReadonlyArray<RunTrace>;
  readonly negotiationDecisions: ReadonlyArray<RunTrace>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isTrace = (value: unknown): value is RunTrace =>
  isRecord(value) &&
  typeof value["playerId"] === "string" &&
  typeof value["attempt"] === "number" &&
  typeof value["outcome"] === "string" &&
  typeof value["elapsedMs"] === "number";

const negotiationEvents = (value: unknown, matchId: string): ReadonlyArray<NegotiationEvent> =>
  Array.isArray(value) &&
  value.every(
    (event) =>
      isRecord(event) &&
      event["schema"] === "catanarchy.negotiation-event.v1" &&
      event["matchId"] === matchId &&
      typeof event["sequence"] === "number" &&
      typeof event["gameSequence"] === "number" &&
      isRecord(event["event"]) &&
      typeof event["event"]["type"] === "string",
  )
    ? (value as ReadonlyArray<NegotiationEvent>)
    : [];

const sessionArray = <T>(session: unknown, key: string): ReadonlyArray<T> =>
  isRecord(session) && Array.isArray(session[key]) ? (session[key] as ReadonlyArray<T>) : [];

const traceArray = (value: unknown): ReadonlyArray<RunTrace> =>
  Array.isArray(value) && value.every(isTrace) ? value : [];

const commandBatchEnds = (events: ReadonlyArray<GameEvent>): ReadonlyArray<number> => {
  const ends: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index + 1]?.commandId !== events[index]?.commandId) ends.push(index + 1);
  }
  return ends;
};

const replayFrames = async (events: ReadonlyArray<GameEvent>): Promise<ReadonlyArray<GameState>> =>
  Promise.all(
    commandBatchEnds(events).map((end) => Effect.runPromise(replay(events.slice(0, end)))),
  );

const SYNTHETIC_FRAME_DURATION_MS = 1_000;

const recordedDuration = (
  gameSequence: number,
  decisions: ReadonlyArray<RunTrace>,
  negotiationDecisions: ReadonlyArray<RunTrace>,
): number =>
  [...decisions, ...negotiationDecisions]
    .filter((trace) => trace.sequence === gameSequence || trace.gameSequence === gameSequence)
    .reduce((total, trace) => total + trace.elapsedMs, 0);

const replayTiming = (
  states: ReadonlyArray<GameState>,
  decisions: ReadonlyArray<RunTrace>,
  negotiationDecisions: ReadonlyArray<RunTrace>,
): Pick<LoadedRunReport, "frameDurationsMs" | "timingSource"> => {
  let recordedFrames = 0;
  const frameDurationsMs = states.slice(0, -1).map((state) => {
    const duration = recordedDuration(state.sequence, decisions, negotiationDecisions);
    if (duration <= 0) return SYNTHETIC_FRAME_DURATION_MS;
    recordedFrames += 1;
    return duration;
  });
  const timingSource =
    recordedFrames === 0
      ? "synthetic"
      : recordedFrames === frameDurationsMs.length
        ? "recorded-model-time"
        : "mixed";
  return { frameDurationsMs, timingSource };
};

export const loadRunReport = async (input: unknown): Promise<LoadedRunReport> => {
  if (!isRecord(input) || !isRecord(input["result"])) {
    throw new Error("The file is not a Catanarchy run report.");
  }
  const result = input["result"];
  if (!Array.isArray(result["events"])) {
    throw new Error("The run report has no game-event log.");
  }
  const events = result["events"] as ReadonlyArray<GameEvent>;
  const states = await replayFrames(events);
  const state = states.at(-1);
  if (state === undefined) throw new Error("The run report has an empty game-event log.");
  const negotiation = negotiationEvents(result["negotiations"], state.matchId);
  const session = result["negotiationSession"];
  const decisions = traceArray(result["decisions"]);
  const negotiationDecisions = traceArray(result["negotiationDecisions"]);
  return {
    state,
    states,
    ...replayTiming(states, decisions, negotiationDecisions),
    events,
    negotiation: {
      schema: "catanarchy.negotiation-view.v1",
      matchId: state.matchId,
      sequence: negotiation.length,
      events: negotiation,
      offers: sessionArray<TradeOffer>(session, "offers"),
      promises: sessionArray<NegotiationPromise>(session, "promises"),
      evidence: sessionArray<PromiseEvidence>(session, "evidence"),
    },
    decisions,
    negotiationDecisions,
  };
};
