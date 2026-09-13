import { isDeepStrictEqual } from "node:util";
import {
  checkInvariants,
  createGame,
  handleCommand,
  legalActions,
  observe,
  replay,
} from "@catanarchy/engine";
import type {
  GameConfig,
  GameEvent,
  GameObservation,
  GameState,
  LegalAction,
  NegotiationAction,
  NegotiationEvent,
  NegotiationView,
  PlayerConfig,
} from "@catanarchy/protocol";
import { Data, Effect } from "effect";
import {
  applyNegotiationAction,
  closeNegotiationWindow,
  negotiatedTurnsOf,
  openNegotiationWindow,
  projectNegotiation,
  restoreNegotiationSession,
  type NegotiationActionResult,
  type NegotiationPolicy,
  type NegotiationSession,
  NegotiationViolation,
} from "./negotiation.js";

export {
  applyNegotiationAction,
  closeNegotiationWindow,
  DEFAULT_NEGOTIATION_POLICY,
  negotiatedTurnsOf,
  openNegotiationWindow,
  projectNegotiation,
  restoreNegotiationSession,
  NegotiationViolation,
} from "./negotiation.js";
export type {
  NegotiationActionResult,
  NegotiationPolicy,
  NegotiationProjectionOptions,
  NegotiationSession,
} from "./negotiation.js";

export interface AgentModelIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly cost: number;
}

export interface AgentDecisionRequest {
  readonly matchId: string;
  readonly sequence: number;
  readonly playerId: string;
  readonly turnKey: string;
  readonly observation: GameObservation;
  readonly legalActions: ReadonlyArray<LegalAction>;
  readonly signal: AbortSignal;
}

export interface AgentDecision {
  readonly actionId: string;
  readonly reason?: string;
  readonly usage?: AgentUsage;
  readonly selectionMode?: "tool" | "text";
}

export interface AgentNegotiationRequest {
  readonly matchId: string;
  readonly gameSequence: number;
  readonly playerId: string;
  readonly turnKey: string;
  readonly turnPlayerId: string;
  readonly round: number;
  readonly observation: GameObservation;
  readonly negotiation: NegotiationView;
  readonly signal: AbortSignal;
}

export interface AgentNegotiationDecision {
  readonly action: NegotiationAction;
  readonly reason?: string;
  readonly usage?: AgentUsage;
  readonly selectionMode?: "tool" | "text";
}

export interface SeatAgent {
  readonly model?: AgentModelIdentity;
  decide(request: AgentDecisionRequest): Promise<AgentDecision>;
  negotiate?(request: AgentNegotiationRequest): Promise<AgentNegotiationDecision>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export type SeatAgentFactory = (player: PlayerConfig) => Promise<SeatAgent>;

export type DecisionFailure =
  | "agent-error"
  | "cancellation-timeout"
  | "deadline"
  | "invalid-action";

export interface DecisionTrace {
  readonly matchId: string;
  readonly sequence: number;
  readonly playerId: string;
  readonly attempt: number;
  readonly outcome: "selected" | "failed" | "fallback";
  readonly actionId?: string;
  readonly reason?: string;
  readonly model?: AgentModelIdentity;
  readonly elapsedMs: number;
  readonly usage?: AgentUsage;
  readonly selectionMode?: "tool" | "text";
  readonly failure?: DecisionFailure;
  readonly failureMessage?: string;
}

export interface NegotiationTrace {
  readonly matchId: string;
  readonly gameSequence: number;
  readonly playerId: string;
  readonly round: number;
  readonly attempt: number;
  readonly outcome: "selected" | "failed" | "fallback";
  readonly actionType?: NegotiationAction["type"];
  readonly reason?: string;
  readonly model?: AgentModelIdentity;
  readonly elapsedMs: number;
  readonly usage?: AgentUsage;
  readonly selectionMode?: "tool" | "text";
  readonly failure?: DecisionFailure;
  readonly failureMessage?: string;
}

export interface MatchRunResult {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly negotiationSession: NegotiationSession | null;
  readonly decisions: ReadonlyArray<DecisionTrace>;
  readonly negotiationDecisions: ReadonlyArray<NegotiationTrace>;
}

export type MatchActivity =
  | { readonly kind: "game.event"; readonly payload: GameEvent }
  | {
      readonly kind: "game.command-completed";
      readonly payload: {
        readonly matchId: string;
        readonly commandId: string;
        readonly sequence: number;
      };
    }
  | { readonly kind: "negotiation.event"; readonly payload: NegotiationEvent }
  | {
      readonly kind: "game.agent-requested";
      readonly payload: {
        readonly attempt: number;
        readonly request: Omit<AgentDecisionRequest, "signal">;
      };
    }
  | { readonly kind: "game.decision"; readonly payload: DecisionTrace }
  | {
      readonly kind: "negotiation.agent-requested";
      readonly payload: {
        readonly attempt: number;
        readonly request: Omit<AgentNegotiationRequest, "signal">;
      };
    }
  | { readonly kind: "negotiation.decision"; readonly payload: NegotiationTrace };

export type MatchActivitySink = (activity: MatchActivity) => void | Promise<void>;

export interface InitialPlacementResult extends MatchRunResult {}

export interface AgentRunOptions {
  readonly config: GameConfig;
  readonly createAgent: SeatAgentFactory;
  readonly decisionTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly negotiationPolicy?: NegotiationPolicy;
  readonly onActivity?: MatchActivitySink;
  /** Continue an existing match from a verified prefix of its timeline. */
  readonly resume?: AgentResume;
}

export interface InitialPlacementOptions extends AgentRunOptions {}

export interface GameStepOptions extends AgentRunOptions {
  readonly maxDecisions: number;
}

export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
}> {}

export class AgentDecisionError extends Data.TaggedError("AgentDecisionError")<{
  readonly message: string;
  readonly usage?: AgentUsage;
}> {}

export class AgentRunAbort extends Data.TaggedError("AgentRunAbort")<{
  readonly message: string;
}> {}

const CANCELLATION_GRACE_MS = 1_000;
const DISPOSAL_GRACE_MS = 1_000;
const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

const resultWithin = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const disposeAgents = async (agents: ReadonlyMap<string, SeatAgent>): Promise<void> => {
  await Promise.all(
    [...agents.values()].map(async (agent) =>
      resultWithin(
        Promise.resolve()
          .then(async () => agent.dispose())
          .then(
            () => true,
            () => true,
          ),
        DISPOSAL_GRACE_MS,
        false,
      ),
    ),
  );
};

const createAgents = async (
  config: GameConfig,
  createAgent: SeatAgentFactory,
): Promise<ReadonlyMap<string, SeatAgent>> => {
  const agents = new Map<string, SeatAgent>();
  try {
    for (const player of config.players) {
      agents.set(player.id, await createAgent(player));
    }
    return agents;
  } catch (error) {
    await disposeAgents(agents);
    throw error;
  }
};

const positiveInteger = (value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new HarnessError({
      message: `${name} must be a positive integer no greater than ${maximum}.`,
    });
  }
};

class CancellationTimeout extends Error {}

type ActivityRecorder = (activity: MatchActivity) => Promise<void>;

const activityRecorder = (sink: MatchActivitySink | undefined): ActivityRecorder =>
  sink === undefined ? async () => {} : async (activity) => sink(structuredClone(activity));

const recordGameEventBatch = async (
  record: ActivityRecorder,
  events: ReadonlyArray<GameEvent>,
): Promise<void> => {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    await record({ kind: "game.event", payload: event });
    if (events[index + 1]?.commandId !== event.commandId) {
      await record({
        kind: "game.command-completed",
        payload: {
          matchId: event.matchId,
          commandId: event.commandId,
          sequence: event.sequence,
        },
      });
    }
  }
};

const recordNegotiationEvents = async (
  record: ActivityRecorder,
  events: ReadonlyArray<NegotiationEvent>,
): Promise<void> => {
  for (const event of events) await record({ kind: "negotiation.event", payload: event });
};

const timeoutDecision = async (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  timeoutMs: number,
): Promise<AgentDecision> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HarnessError({ message: "decision-deadline" }));
      controller.abort();
    }, timeoutMs);
  });

  const decision = Promise.resolve().then(async () =>
    agent.decide({ ...request, signal: controller.signal }),
  );
  try {
    return await Promise.race([decision, deadline]);
  } catch (error) {
    if (controller.signal.aborted) {
      const cancellation = Promise.all([
        Promise.resolve()
          .then(async () => agent.cancel())
          .then(
            () => true,
            () => false,
          ),
        decision.then(
          () => true,
          () => true,
        ),
      ]).then(([cancelled]) => cancelled);
      const cancelled = await resultWithin(cancellation, CANCELLATION_GRACE_MS, false);
      if (!cancelled) throw new CancellationTimeout("Agent cancellation did not settle.");
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const timeoutNegotiation = async (
  agent: SeatAgent,
  request: Omit<AgentNegotiationRequest, "signal">,
  timeoutMs: number,
): Promise<AgentNegotiationDecision> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HarnessError({ message: "decision-deadline" }));
      controller.abort();
    }, timeoutMs);
  });
  const decision = Promise.resolve().then(async () => {
    if (agent.negotiate === undefined) {
      return { action: { type: "pass" } as const };
    }
    return agent.negotiate({ ...request, signal: controller.signal });
  });
  try {
    return await Promise.race([decision, deadline]);
  } catch (error) {
    if (controller.signal.aborted) {
      const cancellation = Promise.all([
        Promise.resolve()
          .then(async () => agent.cancel())
          .then(
            () => true,
            () => false,
          ),
        decision.then(
          () => true,
          () => true,
        ),
      ]).then(([cancelled]) => cancelled);
      const cancelled = await resultWithin(cancellation, CANCELLATION_GRACE_MS, false);
      if (!cancelled) throw new CancellationTimeout("Agent cancellation did not settle.");
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const failureCategory = (error: unknown): DecisionFailure => {
  if (error instanceof CancellationTimeout) return "cancellation-timeout";
  if (error instanceof NegotiationViolation) return "invalid-action";
  return error instanceof HarnessError && error.message === "decision-deadline"
    ? "deadline"
    : "agent-error";
};

const baseTrace = (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  attempt: number,
  outcome: DecisionTrace["outcome"],
  elapsedMs: number,
): DecisionTrace => {
  const trace = {
    matchId: request.matchId,
    sequence: request.sequence,
    playerId: request.playerId,
    attempt,
    outcome,
    elapsedMs,
  };
  return agent.model === undefined ? trace : { ...trace, model: agent.model };
};

const selectedTrace = (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  decision: AgentDecision,
  action: LegalAction,
  attempt: number,
  elapsedMs: number,
): DecisionTrace => {
  const privateChoice = action.command.command.type === "discard-resource";
  return {
    ...baseTrace(agent, request, attempt, "selected", elapsedMs),
    actionId: action.id,
    ...(!privateChoice && decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    ...(decision.selectionMode === undefined ? {} : { selectionMode: decision.selectionMode }),
  };
};

/**
 * The agent error text is kept because it separates two failures that share the
 * `agent-error` category: an exhausted time pool, which spends no tokens, and a
 * model answer that carried no legal action, which spends tokens.
 */
const failureMessageOf = (error: unknown): string | undefined =>
  error instanceof Error && error.message.length > 0 ? error.message : undefined;

const lastFailureMessage = (
  traces: ReadonlyArray<{ readonly failureMessage?: string }>,
): string | undefined => traces.at(-1)?.failureMessage;

const withFailureMessage = <Trace extends { readonly failureMessage?: string }>(
  trace: Trace,
  failureMessage: string | undefined,
): Trace => (failureMessage === undefined ? trace : { ...trace, failureMessage });

const failedAttemptTrace = (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  attempt: number,
  elapsedMs: number,
  failure: DecisionFailure,
  usage?: AgentUsage,
  failureMessage?: string,
): DecisionTrace => ({
  ...baseTrace(agent, request, attempt, "failed", elapsedMs),
  ...(usage === undefined ? {} : { usage }),
  ...(failureMessage === undefined ? {} : { failureMessage }),
  failure,
});

const invalidActionTrace = (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  decision: AgentDecision,
  attempt: number,
  elapsedMs: number,
): DecisionTrace => ({
  ...baseTrace(agent, request, attempt, "failed", elapsedMs),
  ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  failure: "invalid-action",
});

interface ChosenAction {
  readonly action: LegalAction;
  readonly traces: ReadonlyArray<DecisionTrace>;
}

const rethrowRunAbort = (error: unknown): void => {
  if (error instanceof AgentRunAbort) throw error;
};

const chooseAction = async (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  canonicalActions: ReadonlyArray<LegalAction>,
  unavailableAgents: WeakSet<SeatAgent>,
  timeoutMs: number,
  maxAttempts: number,
  record: ActivityRecorder,
): Promise<ChosenAction> => {
  const traces: DecisionTrace[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (unavailableAgents.has(agent)) break;
    await record({ kind: "game.agent-requested", payload: { attempt, request } });
    const startedAt = performance.now();
    try {
      const decision = await timeoutDecision(agent, request, timeoutMs);
      const action = canonicalActions.find(({ id }) => id === decision.actionId);
      const elapsedMs = performance.now() - startedAt;
      if (action !== undefined) {
        const trace = selectedTrace(agent, request, decision, action, attempt, elapsedMs);
        traces.push(trace);
        await record({ kind: "game.decision", payload: trace });
        return { action, traces };
      }
      const trace = invalidActionTrace(agent, request, decision, attempt, elapsedMs);
      traces.push(trace);
      await record({ kind: "game.decision", payload: trace });
    } catch (error) {
      rethrowRunAbort(error);
      const failure = failureCategory(error);
      const trace = failedAttemptTrace(
        agent,
        request,
        attempt,
        performance.now() - startedAt,
        failure,
        error instanceof AgentDecisionError ? error.usage : undefined,
        failureMessageOf(error),
      );
      traces.push(trace);
      await record({ kind: "game.decision", payload: trace });
      if (failure === "cancellation-timeout") unavailableAgents.add(agent);
    }
  }

  const action = canonicalActions[0];
  if (action === undefined) {
    throw new HarnessError({ message: "The active player has no legal action." });
  }
  const trace: DecisionTrace = withFailureMessage(
    {
      ...baseTrace(agent, request, maxAttempts + 1, "fallback", 0),
      actionId: action.id,
    },
    lastFailureMessage(traces),
  );
  traces.push(trace);
  await record({ kind: "game.decision", payload: trace });
  return { action, traces };
};

const actionsForState = (
  state: GameState,
  allowNoLegalActions: boolean,
): ReadonlyArray<LegalAction> => {
  const actions = legalActions(state);
  if (actions.length === 0 && !allowNoLegalActions) {
    throw new HarnessError({ message: "The active player has no legal action." });
  }
  return actions;
};

interface NegotiationWindowResult {
  readonly state: GameState;
  readonly session: NegotiationSession;
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiationEvents: ReadonlyArray<NegotiationEvent>;
  readonly traces: ReadonlyArray<NegotiationTrace>;
}

const negotiationOrder = (
  config: GameConfig,
  turnPlayerId: string,
): ReadonlyArray<PlayerConfig> => {
  const start = config.players.findIndex(({ id }) => id === turnPlayerId);
  return start < 0
    ? []
    : config.players.map(
        (_player, offset) => config.players[(start + offset) % config.players.length]!,
      );
};

const negotiationTraceBase = (
  agent: SeatAgent,
  request: Omit<AgentNegotiationRequest, "signal">,
  attempt: number,
  outcome: NegotiationTrace["outcome"],
  elapsedMs: number,
): NegotiationTrace => ({
  matchId: request.matchId,
  gameSequence: request.gameSequence,
  playerId: request.playerId,
  round: request.round,
  attempt,
  outcome,
  elapsedMs,
  ...(agent.model === undefined ? {} : { model: agent.model }),
});

const selectedNegotiationTrace = (
  agent: SeatAgent,
  request: Omit<AgentNegotiationRequest, "signal">,
  decision: AgentNegotiationDecision,
  attempt: number,
  elapsedMs: number,
): NegotiationTrace => ({
  ...negotiationTraceBase(agent, request, attempt, "selected", elapsedMs),
  actionType: decision.action.type,
  ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  ...(decision.selectionMode === undefined ? {} : { selectionMode: decision.selectionMode }),
});

const failedNegotiationTrace = (
  agent: SeatAgent,
  request: Omit<AgentNegotiationRequest, "signal">,
  error: unknown,
  attempt: number,
  elapsedMs: number,
): NegotiationTrace => {
  const failureMessage = failureMessageOf(error);
  return {
    ...negotiationTraceBase(agent, request, attempt, "failed", elapsedMs),
    failure: failureCategory(error),
    ...(error instanceof AgentDecisionError && error.usage !== undefined
      ? { usage: error.usage }
      : {}),
    ...(failureMessage === undefined ? {} : { failureMessage }),
  };
};

const turnKeyForState = (state: GameState): string => {
  const phase = state.phase;
  if (phase.tag === "setup.settlement" || phase.tag === "setup.road") {
    return `setup:${phase.direction}:${String(phase.playerIndex)}`;
  }
  if ("turn" in phase) return `turn:${String(phase.turn)}`;
  return `sequence:${String(state.sequence)}`;
};

const applyNegotiationFallback = async (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: string,
): Promise<NegotiationActionResult> =>
  Effect.runPromise(applyNegotiationAction(state, session, round, playerId, { type: "pass" }));

interface NegotiationChoice {
  readonly applied: NegotiationActionResult;
  readonly traces: ReadonlyArray<NegotiationTrace>;
}

const chooseNegotiationAction = async (
  state: GameState,
  session: NegotiationSession,
  round: number,
  player: PlayerConfig,
  agent: SeatAgent,
  timeoutMs: number,
  maxAttempts: number,
  unavailableAgents: WeakSet<SeatAgent>,
  record: ActivityRecorder,
): Promise<NegotiationChoice> => {
  const request: Omit<AgentNegotiationRequest, "signal"> = {
    matchId: state.matchId,
    gameSequence: state.sequence,
    playerId: player.id,
    turnKey: turnKeyForState(state),
    turnPlayerId: session.turnPlayerId,
    round,
    observation: structuredClone(observe(state, { type: "player", playerId: player.id })),
    negotiation: structuredClone(
      projectNegotiation(
        session,
        { type: "player", playerId: player.id },
        { currentWindowOnly: true },
      ),
    ),
  };
  const traces: NegotiationTrace[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (unavailableAgents.has(agent)) break;
    await record({ kind: "negotiation.agent-requested", payload: { attempt, request } });
    const startedAt = performance.now();
    try {
      const decision = await timeoutNegotiation(agent, structuredClone(request), timeoutMs);
      const applied = await Effect.runPromise(
        applyNegotiationAction(state, session, round, player.id, decision.action),
      );
      const trace = selectedNegotiationTrace(
        agent,
        request,
        decision,
        attempt,
        performance.now() - startedAt,
      );
      traces.push(trace);
      await record({ kind: "negotiation.decision", payload: trace });
      return { applied, traces };
    } catch (error) {
      rethrowRunAbort(error);
      const failure = failureCategory(error);
      if (failure === "cancellation-timeout") unavailableAgents.add(agent);
      const trace = failedNegotiationTrace(
        agent,
        request,
        error,
        attempt,
        performance.now() - startedAt,
      );
      traces.push(trace);
      await record({ kind: "negotiation.decision", payload: trace });
    }
  }
  const applied = await applyNegotiationFallback(state, session, round, player.id);
  const trace: NegotiationTrace = withFailureMessage(
    {
      ...negotiationTraceBase(agent, request, maxAttempts + 1, "fallback", 0),
      actionType: "pass",
    },
    lastFailureMessage(traces),
  );
  traces.push(trace);
  await record({ kind: "negotiation.decision", payload: trace });
  return { applied, traces };
};

interface NegotiationRoundResult {
  readonly state: GameState;
  readonly session: NegotiationSession;
  readonly gameEvents: ReadonlyArray<GameEvent>;
  readonly traces: ReadonlyArray<NegotiationTrace>;
  readonly passes: number;
}

const isPassResult = (result: NegotiationActionResult): boolean =>
  result.session.events.at(-1)?.event.type === "negotiation.player-passed";

const runNegotiationRound = async (
  initialState: GameState,
  initialSession: NegotiationSession,
  round: number,
  order: ReadonlyArray<PlayerConfig>,
  agents: ReadonlyMap<string, SeatAgent>,
  timeoutMs: number,
  maxAttempts: number,
  unavailableAgents: WeakSet<SeatAgent>,
  record: ActivityRecorder,
): Promise<NegotiationRoundResult> => {
  let state = initialState;
  let session = initialSession;
  let passes = 0;
  const gameEvents: GameEvent[] = [];
  const traces: NegotiationTrace[] = [];
  for (const player of order) {
    const agent = agents.get(player.id);
    if (agent === undefined) {
      throw new HarnessError({ message: `No agent exists for player ${player.id}.` });
    }
    const previousNegotiationEventCount = session.events.length;
    const choice = await chooseNegotiationAction(
      state,
      session,
      round,
      player,
      agent,
      timeoutMs,
      maxAttempts,
      unavailableAgents,
      record,
    );
    await recordNegotiationEvents(
      record,
      choice.applied.session.events.slice(previousNegotiationEventCount),
    );
    await recordGameEventBatch(record, choice.applied.gameEvents);
    if (isPassResult(choice.applied)) passes += 1;
    state = choice.applied.state;
    session = choice.applied.session;
    gameEvents.push(...choice.applied.gameEvents);
    traces.push(...choice.traces);
  }
  return { state, session, gameEvents, traces, passes };
};

const runNegotiationWindow = async (
  stateAtOpen: GameState,
  agents: ReadonlyMap<string, SeatAgent>,
  policy: NegotiationPolicy,
  timeoutMs: number,
  maxAttempts: number,
  initialNegotiationSequence: number,
  unavailableAgents: WeakSet<SeatAgent>,
  history: NegotiationSession | null,
  record: ActivityRecorder,
): Promise<NegotiationWindowResult> => {
  let state = stateAtOpen;
  const historicalEventCount = history?.events.length ?? 0;
  let session = await Effect.runPromise(
    openNegotiationWindow(state, policy, initialNegotiationSequence, history ?? undefined),
  );
  await recordNegotiationEvents(record, session.events.slice(historicalEventCount));
  const gameEvents: GameEvent[] = [];
  const traces: NegotiationTrace[] = [];
  const order = negotiationOrder(state.config, session.turnPlayerId);

  for (let round = 1; round <= policy.maxRounds; round += 1) {
    const result = await runNegotiationRound(
      state,
      session,
      round,
      order,
      agents,
      timeoutMs,
      maxAttempts,
      unavailableAgents,
      record,
    );
    state = result.state;
    session = result.session;
    gameEvents.push(...result.gameEvents);
    traces.push(...result.traces);
    if (result.passes === order.length) {
      const eventCount = session.events.length;
      session = closeNegotiationWindow(state, session, "all-passed");
      await recordNegotiationEvents(record, session.events.slice(eventCount));
      return {
        state,
        session,
        events: gameEvents,
        negotiationEvents: session.events.slice(historicalEventCount),
        traces,
      };
    }
  }

  const eventCount = session.events.length;
  session = closeNegotiationWindow(state, session, "round-limit");
  await recordNegotiationEvents(record, session.events.slice(eventCount));
  return {
    state,
    session,
    events: gameEvents,
    negotiationEvents: session.events.slice(historicalEventCount),
    traces,
  };
};

interface RunNegotiationState {
  readonly events: GameEvent[];
  readonly negotiations: NegotiationEvent[];
  negotiationSession: NegotiationSession | null;
  readonly negotiationDecisions: NegotiationTrace[];
  readonly negotiatedTurns: Set<number>;
}

const negotiateCurrentTurn = async (
  state: GameState,
  options: AgentRunOptions,
  agents: ReadonlyMap<string, SeatAgent>,
  run: RunNegotiationState,
  timeoutMs: number,
  maxAttempts: number,
  unavailableAgents: WeakSet<SeatAgent>,
  record: ActivityRecorder,
): Promise<GameState> => {
  if (
    state.phase.tag !== "turn.action" ||
    options.negotiationPolicy === undefined ||
    run.negotiatedTurns.has(state.phase.turn)
  ) {
    return state;
  }
  const negotiated = await runNegotiationWindow(
    state,
    agents,
    options.negotiationPolicy,
    timeoutMs,
    maxAttempts,
    (run.negotiations.at(-1)?.sequence ?? -1) + 1,
    unavailableAgents,
    run.negotiationSession,
    record,
  );
  run.negotiatedTurns.add(state.phase.turn);
  run.events.push(...negotiated.events);
  run.negotiations.push(...negotiated.negotiationEvents);
  run.negotiationSession = negotiated.session;
  run.negotiationDecisions.push(...negotiated.traces);
  return negotiated.state;
};

/**
 * A match continues from a stored prefix of its own timeline. The payloads are
 * the canonical form of the prefix, so the harness can verify the state instead
 * of trusting it.
 */
export interface AgentResume {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly eventPayloads: ReadonlyArray<unknown>;
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly decisionCount: number;
}

const verifiedResumeState = async (resume: AgentResume): Promise<GameState> => {
  const replayed = await Effect.runPromise(
    replay(resume.eventPayloads).pipe(
      Effect.mapError(() => new HarnessError({ message: "The resumed prefix does not replay." })),
    ),
  );
  if (!isDeepStrictEqual(replayed, resume.state)) {
    throw new HarnessError({
      message: "The resumed prefix does not reproduce the stored starting state.",
    });
  }
  const violations = checkInvariants(replayed);
  if (violations.length > 0) {
    throw new HarnessError({ message: `The resumed state is invalid: ${violations[0]}` });
  }
  return replayed;
};

const resumedNegotiationSession = (
  options: AgentRunOptions,
  resume: AgentResume,
): NegotiationSession | null => {
  if (resume.negotiations.length === 0) return null;
  const policy = options.negotiationPolicy;
  if (policy === undefined) {
    throw new HarnessError({
      message: "The resumed run has negotiation history but no negotiation policy.",
    });
  }
  try {
    return restoreNegotiationSession(policy, resume.negotiations);
  } catch (error) {
    throw new HarnessError({
      message: error instanceof Error ? error.message : "The negotiation history is invalid.",
    });
  }
};

interface RunStart {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly decisionCount: number;
  readonly negotiationSession: NegotiationSession | null;
  readonly negotiatedTurns: ReadonlySet<number>;
}

const freshRunStart = async (
  options: AgentRunOptions,
  record: ActivityRecorder,
): Promise<RunStart> => {
  const created = await Effect.runPromise(createGame(options.config));
  await recordGameEventBatch(record, created.events);
  return {
    state: created.state,
    events: created.events,
    negotiations: [],
    decisionCount: 0,
    negotiationSession: null,
    negotiatedTurns: new Set<number>(),
  };
};

const resumedRunStart = async (
  options: AgentRunOptions,
  resume: AgentResume,
): Promise<RunStart> => ({
  state: await verifiedResumeState(resume),
  events: resume.events,
  negotiations: resume.negotiations,
  decisionCount: resume.decisionCount,
  negotiationSession: resumedNegotiationSession(options, resume),
  negotiatedTurns: new Set(negotiatedTurnsOf(resume.negotiations)),
});

const runWithAgents = async (
  options: AgentRunOptions,
  agents: ReadonlyMap<string, SeatAgent>,
  shouldContinue: (state: GameState, decisionCount: number) => boolean,
  allowNoLegalActions: boolean,
): Promise<MatchRunResult> => {
  const timeoutMs = options.decisionTimeoutMs ?? 720_000;
  const maxAttempts = options.maxAttempts ?? 1;
  positiveInteger(timeoutMs, "decisionTimeoutMs", MAX_TIMER_DELAY_MS);
  positiveInteger(maxAttempts, "maxAttempts");
  const record = activityRecorder(options.onActivity);
  const started =
    options.resume === undefined
      ? await freshRunStart(options, record)
      : await resumedRunStart(options, options.resume);

  let state = started.state;
  const events: GameEvent[] = [...started.events];
  const negotiations: NegotiationEvent[] = [...started.negotiations];
  const decisions: DecisionTrace[] = [];
  const negotiationDecisions: NegotiationTrace[] = [];
  const unavailableAgents = new WeakSet<SeatAgent>();
  const runNegotiationState: RunNegotiationState = {
    events,
    negotiations,
    negotiationSession: started.negotiationSession,
    negotiationDecisions,
    negotiatedTurns: new Set(started.negotiatedTurns),
  };
  let decisionCount = started.decisionCount;

  while (shouldContinue(state, decisionCount)) {
    state = await negotiateCurrentTurn(
      state,
      options,
      agents,
      runNegotiationState,
      timeoutMs,
      maxAttempts,
      unavailableAgents,
      record,
    );
    const activePlayer = options.config.players[state.phase.playerIndex];
    if (activePlayer === undefined) {
      throw new HarnessError({ message: "The active player index is invalid." });
    }
    const agent = agents.get(activePlayer.id);
    if (agent === undefined) {
      throw new HarnessError({ message: `No agent exists for player ${activePlayer.id}.` });
    }
    const actions = actionsForState(state, allowNoLegalActions);
    if (actions.length === 0) break;
    const chosen = await chooseAction(
      agent,
      {
        matchId: state.matchId,
        sequence: state.sequence,
        playerId: activePlayer.id,
        turnKey: turnKeyForState(state),
        observation: structuredClone(observe(state, { type: "player", playerId: activePlayer.id })),
        legalActions: structuredClone(actions),
      },
      actions,
      unavailableAgents,
      timeoutMs,
      maxAttempts,
      record,
    );
    decisions.push(...chosen.traces);
    const result = await Effect.runPromise(handleCommand(state, chosen.action.command));
    await recordGameEventBatch(record, result.events);
    state = result.state;
    events.push(...result.events);
    decisionCount += 1;
  }

  return {
    state,
    events,
    negotiations,
    negotiationSession: runNegotiationState.negotiationSession,
    decisions,
    negotiationDecisions,
  };
};

export const runInitialPlacement = (
  options: InitialPlacementOptions,
): Effect.Effect<InitialPlacementResult, HarnessError | AgentRunAbort> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => createAgents(options.config, options.createAgent),
      catch: () => new HarnessError({ message: "An agent could not be created." }),
    }),
    (agents) =>
      Effect.tryPromise({
        try: async () =>
          runWithAgents(options, agents, (state) => state.phase.tag !== "turn.roll", false),
        catch: (error) =>
          error instanceof HarnessError || error instanceof AgentRunAbort
            ? error
            : new HarnessError({ message: "The initial-placement match failed." }),
      }),
    (agents) => Effect.promise(async () => disposeAgents(agents)),
  );

export const runGameSteps = (
  options: GameStepOptions,
): Effect.Effect<MatchRunResult, HarnessError | AgentRunAbort> => {
  try {
    positiveInteger(options.maxDecisions, "maxDecisions");
  } catch (error) {
    return Effect.fail(
      error instanceof HarnessError
        ? error
        : new HarnessError({ message: "maxDecisions is invalid." }),
    );
  }
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => createAgents(options.config, options.createAgent),
      catch: () => new HarnessError({ message: "An agent could not be created." }),
    }),
    (agents) =>
      Effect.tryPromise({
        try: async () =>
          runWithAgents(
            options,
            agents,
            (_state, decisionCount) => decisionCount < options.maxDecisions,
            true,
          ),
        catch: (error) =>
          error instanceof HarnessError || error instanceof AgentRunAbort
            ? error
            : new HarnessError({ message: "The game-step run failed." }),
      }),
    (agents) => Effect.promise(async () => disposeAgents(agents)),
  );
};

export const createFirstLegalAgent = (): SeatAgent => ({
  async decide(request) {
    const action = request.legalActions[0];
    if (action === undefined) {
      throw new HarnessError({ message: "The scripted agent has no legal action." });
    }
    return { actionId: action.id, reason: "deterministic first legal action" };
  },
  async cancel() {},
  async dispose() {},
});
