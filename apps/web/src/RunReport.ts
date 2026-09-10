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

export interface ReplayFrame {
  readonly state: GameState;
  readonly offsetMs: number;
  readonly gameEventCount: number;
  readonly negotiationEventCount: number;
  readonly decisionCount: number;
  readonly negotiationDecisionCount: number;
}

export interface LoadedRunReport {
  readonly state: GameState;
  readonly frames: ReadonlyArray<ReplayFrame>;
  readonly frameDurationsMs: ReadonlyArray<number>;
  readonly timingSource: "recorded-time" | "recorded-model-time" | "mixed" | "synthetic";
  readonly status: "partial" | "completed" | "failed" | "cancelled";
  readonly sessionSeatIds: ReadonlyArray<string>;
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiation: NegotiationView;
  readonly decisions: ReadonlyArray<RunTrace>;
  readonly negotiationDecisions: ReadonlyArray<RunTrace>;
}

export interface RunPackageSnapshot {
  readonly manifest: unknown;
  readonly records: ReadonlyArray<unknown>;
}

interface BrowserRunRecord {
  readonly runId: string;
  readonly index: number;
  readonly offsetMs: number;
  readonly kind: string;
  readonly payload: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isTraceOutcome = (value: unknown): value is RunTrace["outcome"] =>
  value === "selected" || value === "failed" || value === "fallback";

const hasTraceIdentity = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value["playerId"] === "string" &&
  Number.isSafeInteger(value["attempt"]) &&
  isTraceOutcome(value["outcome"]);

const hasTraceTiming = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value["elapsedMs"] === "number" &&
  Number.isFinite(value["elapsedMs"]) &&
  value["elapsedMs"] >= 0;

const isTrace = (value: unknown): value is RunTrace =>
  isRecord(value) && hasTraceIdentity(value) && hasTraceTiming(value);

const isGameEvent = (value: unknown): value is GameEvent =>
  isRecord(value) &&
  value["schema"] === "catanarchy.game-event.v1" &&
  typeof value["matchId"] === "string" &&
  Number.isSafeInteger(value["sequence"]) &&
  typeof value["commandId"] === "string" &&
  isRecord(value["event"]) &&
  typeof value["event"]["type"] === "string";

const isNegotiationEvent = (value: unknown): value is NegotiationEvent =>
  isRecord(value) &&
  value["schema"] === "catanarchy.negotiation-event.v1" &&
  typeof value["matchId"] === "string" &&
  Number.isSafeInteger(value["sequence"]) &&
  Number.isSafeInteger(value["gameSequence"]) &&
  isRecord(value["event"]) &&
  typeof value["event"]["type"] === "string";

const negotiationEvents = (value: unknown, matchId: string): ReadonlyArray<NegotiationEvent> =>
  Array.isArray(value) &&
  value.every((event) => isNegotiationEvent(event) && event.matchId === matchId)
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

const replayStates = async (
  events: ReadonlyArray<GameEvent>,
  ends: ReadonlyArray<number>,
): Promise<ReadonlyArray<GameState>> =>
  Promise.all(ends.map((end) => Effect.runPromise(replay(events.slice(0, end)))));

const SYNTHETIC_FRAME_DURATION_MS = 1_000;

const recordedDuration = (
  gameSequence: number,
  decisions: ReadonlyArray<RunTrace>,
  negotiationDecisions: ReadonlyArray<RunTrace>,
): number =>
  [...decisions, ...negotiationDecisions]
    .filter((trace) => trace.sequence === gameSequence || trace.gameSequence === gameSequence)
    .reduce((total, trace) => total + trace.elapsedMs, 0);

const oldReportTiming = (
  states: ReadonlyArray<GameState>,
  decisions: ReadonlyArray<RunTrace>,
  negotiationDecisions: ReadonlyArray<RunTrace>,
): {
  readonly durations: ReadonlyArray<number>;
  readonly source: LoadedRunReport["timingSource"];
} => {
  let recordedFrames = 0;
  const durations = states.slice(0, -1).map((state) => {
    const duration = recordedDuration(state.sequence, decisions, negotiationDecisions);
    if (duration <= 0) return SYNTHETIC_FRAME_DURATION_MS;
    recordedFrames += 1;
    return duration;
  });
  const source =
    recordedFrames === 0
      ? "synthetic"
      : recordedFrames === durations.length
        ? "recorded-model-time"
        : "mixed";
  return { durations, source };
};

const frameDurations = (frames: ReadonlyArray<ReplayFrame>): ReadonlyArray<number> =>
  frames.slice(0, -1).map((frame, index) => {
    const next = frames[index + 1];
    return next === undefined ? 0 : Math.max(0, next.offsetMs - frame.offsetMs);
  });

const negotiationView = (
  matchId: string,
  events: ReadonlyArray<NegotiationEvent>,
  session?: unknown,
): NegotiationView => ({
  schema: "catanarchy.negotiation-view.v1",
  matchId,
  sequence: events.length,
  events,
  offers: sessionArray<TradeOffer>(session, "offers"),
  promises: sessionArray<NegotiationPromise>(session, "promises"),
  evidence: sessionArray<PromiseEvidence>(session, "evidence"),
});

export const loadRunReport = async (input: unknown): Promise<LoadedRunReport> => {
  if (!isRecord(input) || !isRecord(input["result"])) {
    throw new Error("The file is not a Catanarchy run report.");
  }
  const result = input["result"];
  if (!Array.isArray(result["events"]) || !result["events"].every(isGameEvent)) {
    throw new Error("The run report has no valid game-event log.");
  }
  const events = result["events"];
  const ends = commandBatchEnds(events);
  const states = await replayStates(events, ends);
  const state = states.at(-1);
  if (state === undefined) throw new Error("The run report has an empty game-event log.");
  const negotiation = negotiationEvents(result["negotiations"], state.matchId);
  const decisions = traceArray(result["decisions"]);
  const negotiationDecisions = traceArray(result["negotiationDecisions"]);
  const timing = oldReportTiming(states, decisions, negotiationDecisions);
  let offsetMs = 0;
  const frames = states.map((frameState, index): ReplayFrame => {
    const frame = {
      state: frameState,
      offsetMs,
      gameEventCount: ends[index] ?? events.length,
      negotiationEventCount: negotiation.filter(
        ({ gameSequence }) => gameSequence < frameState.sequence,
      ).length,
      decisionCount: decisions.filter(
        ({ sequence }) => sequence !== undefined && sequence < frameState.sequence,
      ).length,
      negotiationDecisionCount: negotiationDecisions.filter(
        ({ gameSequence }) => gameSequence !== undefined && gameSequence < frameState.sequence,
      ).length,
    };
    offsetMs += timing.durations[index] ?? 0;
    return frame;
  });
  return {
    state,
    frames,
    frameDurationsMs: timing.durations,
    timingSource: timing.source,
    status: "completed",
    sessionSeatIds: [],
    events,
    negotiation: negotiationView(state.matchId, negotiation, result["negotiationSession"]),
    decisions,
    negotiationDecisions,
  };
};

const isRunStatus = (value: unknown): value is LoadedRunReport["status"] =>
  value === "partial" || value === "completed" || value === "failed" || value === "cancelled";

const isBrowserManifest = (
  value: unknown,
): value is Readonly<Record<string, unknown>> & {
  readonly runId: string;
  readonly matchId: string;
  readonly status: LoadedRunReport["status"];
  readonly seats: ReadonlyArray<unknown>;
} =>
  isRecord(value) &&
  value["schema"] === "catanarchy.run-manifest.v1" &&
  typeof value["runId"] === "string" &&
  typeof value["matchId"] === "string" &&
  isRunStatus(value["status"]) &&
  Array.isArray(value["seats"]);

const parseManifest = (
  value: unknown,
): {
  readonly runId: string;
  readonly matchId: string;
  readonly status: LoadedRunReport["status"];
  readonly sessionSeatIds: ReadonlyArray<string>;
} => {
  if (!isBrowserManifest(value)) throw new Error("The run manifest is invalid.");
  const sessionSeatIds = value["seats"].flatMap((seat) =>
    isRecord(seat) && typeof seat["seatId"] === "string" && typeof seat["sessionFile"] === "string"
      ? [seat["seatId"]]
      : [],
  );
  return {
    runId: value["runId"],
    matchId: value["matchId"],
    status: value["status"],
    sessionSeatIds,
  };
};

const parseBrowserRecord = (value: unknown): BrowserRunRecord => {
  if (
    !isRecord(value) ||
    value["schema"] !== "catanarchy.run-record.v1" ||
    typeof value["runId"] !== "string" ||
    !Number.isSafeInteger(value["index"]) ||
    !Number.isSafeInteger(value["offsetMs"]) ||
    typeof value["kind"] !== "string" ||
    !("payload" in value)
  ) {
    throw new Error("The run timeline contains an invalid record.");
  }
  return {
    runId: value["runId"],
    index: value["index"] as number,
    offsetMs: value["offsetMs"] as number,
    kind: value["kind"],
    payload: value["payload"],
  };
};

interface TimelineBuild {
  readonly matchId: string;
  readonly events: GameEvent[];
  readonly negotiations: NegotiationEvent[];
  readonly decisions: RunTrace[];
  readonly negotiationDecisions: RunTrace[];
  readonly frames: ReplayFrame[];
  state: GameState | undefined;
  completedGameEventCount: number;
}

const newTimelineBuild = (matchId: string): TimelineBuild => ({
  matchId,
  events: [],
  negotiations: [],
  decisions: [],
  negotiationDecisions: [],
  frames: [],
  state: undefined,
  completedGameEventCount: 0,
});

const pushFrame = (build: TimelineBuild, offsetMs: number): void => {
  if (build.state === undefined) return;
  build.frames.push({
    state: build.state,
    offsetMs,
    gameEventCount: build.completedGameEventCount,
    negotiationEventCount: build.negotiations.length,
    decisionCount: build.decisions.length,
    negotiationDecisionCount: build.negotiationDecisions.length,
  });
};

const addGameEvent = (build: TimelineBuild, payload: unknown): void => {
  if (!isGameEvent(payload) || payload.matchId !== build.matchId) {
    throw new Error("The run timeline contains an invalid game event.");
  }
  build.events.push(payload);
};

const completeGameCommand = async (
  build: TimelineBuild,
  record: BrowserRunRecord,
): Promise<void> => {
  if (!isRecord(record.payload)) throw new Error("The command marker is invalid.");
  const batch = build.events.slice(build.completedGameEventCount);
  const last = batch.at(-1);
  const commandId = record.payload["commandId"];
  const oneCommand =
    last !== undefined && batch.every((event) => event.commandId === last.commandId);
  if (
    last === undefined ||
    typeof commandId !== "string" ||
    commandId !== last.commandId ||
    !oneCommand ||
    record.payload["sequence"] !== last.sequence
  ) {
    throw new Error("The command marker does not match its game-event batch.");
  }
  build.state = await Effect.runPromise(replay(build.events));
  build.completedGameEventCount = build.events.length;
  pushFrame(build, record.offsetMs);
};

const addNegotiationEvent = (build: TimelineBuild, payload: unknown, offsetMs: number): void => {
  if (!isNegotiationEvent(payload) || payload.matchId !== build.matchId) {
    throw new Error("The run timeline contains an invalid negotiation event.");
  }
  build.negotiations.push(payload);
  pushFrame(build, offsetMs);
};

const addDecision = (
  build: TimelineBuild,
  payload: unknown,
  offsetMs: number,
  negotiation: boolean,
): void => {
  if (!isTrace(payload)) throw new Error("The run timeline contains an invalid decision.");
  (negotiation ? build.negotiationDecisions : build.decisions).push(payload);
  pushFrame(build, offsetMs);
};

const consumeRecord = async (build: TimelineBuild, record: BrowserRunRecord): Promise<void> => {
  switch (record.kind) {
    case "game.event":
      addGameEvent(build, record.payload);
      break;
    case "game.command-completed":
      await completeGameCommand(build, record);
      break;
    case "negotiation.event":
      addNegotiationEvent(build, record.payload, record.offsetMs);
      break;
    case "game.decision":
      addDecision(build, record.payload, record.offsetMs, false);
      break;
    case "negotiation.decision":
      addDecision(build, record.payload, record.offsetMs, true);
      break;
    default:
      break;
  }
};

const assertRecordOrder = (
  record: BrowserRunRecord,
  runId: string,
  expectedIndex: number,
  previousOffset: number,
): void => {
  if (
    record.runId !== runId ||
    record.index !== expectedIndex ||
    record.offsetMs < previousOffset
  ) {
    throw new Error("The run timeline order is invalid.");
  }
};

export const loadRunPackage = async (input: RunPackageSnapshot): Promise<LoadedRunReport> => {
  const manifest = parseManifest(input.manifest);
  const records = input.records.map(parseBrowserRecord);
  const build = newTimelineBuild(manifest.matchId);
  let previousOffset = -1;
  for (const [index, record] of records.entries()) {
    assertRecordOrder(record, manifest.runId, index, previousOffset);
    previousOffset = record.offsetMs;
    await consumeRecord(build, record);
  }
  if (build.events.length !== build.completedGameEventCount && manifest.status !== "partial") {
    throw new Error("The completed run ends inside a game-event batch.");
  }
  const finalState = build.frames.at(-1)?.state;
  if (finalState === undefined) throw new Error("The run package has no complete game state.");
  return {
    state: finalState,
    frames: build.frames,
    frameDurationsMs: frameDurations(build.frames),
    timingSource: "recorded-time",
    status: manifest.status,
    sessionSeatIds: manifest.sessionSeatIds,
    events: build.events,
    negotiation: negotiationView(manifest.matchId, build.negotiations),
    decisions: build.decisions,
    negotiationDecisions: build.negotiationDecisions,
  };
};
