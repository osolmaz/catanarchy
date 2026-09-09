import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
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
  openNegotiationWindow,
  projectNegotiation,
  type NegotiationActionResult,
  type NegotiationPolicy,
  type NegotiationSession,
  NegotiationViolation,
} from "./negotiation.js";

export {
  applyNegotiationAction,
  closeNegotiationWindow,
  DEFAULT_NEGOTIATION_POLICY,
  openNegotiationWindow,
  projectNegotiation,
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
}

export interface MatchRunResult {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly negotiationSession: NegotiationSession | null;
  readonly decisions: ReadonlyArray<DecisionTrace>;
  readonly negotiationDecisions: ReadonlyArray<NegotiationTrace>;
}

export interface InitialPlacementResult extends MatchRunResult {}

export interface AgentRunOptions {
  readonly config: GameConfig;
  readonly createAgent: SeatAgentFactory;
  readonly decisionTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly negotiationPolicy?: NegotiationPolicy;
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
            () => true,
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

const failedAttemptTrace = (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  attempt: number,
  elapsedMs: number,
  failure: DecisionFailure,
  usage?: AgentUsage,
): DecisionTrace => ({
  ...baseTrace(agent, request, attempt, "failed", elapsedMs),
  ...(usage === undefined ? {} : { usage }),
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

const chooseAction = async (
  agent: SeatAgent,
  request: Omit<AgentDecisionRequest, "signal">,
  canonicalActions: ReadonlyArray<LegalAction>,
  unavailableAgents: WeakSet<SeatAgent>,
  timeoutMs: number,
  maxAttempts: number,
): Promise<ChosenAction> => {
  const traces: DecisionTrace[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (unavailableAgents.has(agent)) break;
    const startedAt = performance.now();
    try {
      const decision = await timeoutDecision(agent, request, timeoutMs);
      const action = canonicalActions.find(({ id }) => id === decision.actionId);
      const elapsedMs = performance.now() - startedAt;
      if (action !== undefined) {
        traces.push(selectedTrace(agent, request, decision, action, attempt, elapsedMs));
        return { action, traces };
      }
      traces.push(invalidActionTrace(agent, request, decision, attempt, elapsedMs));
    } catch (error) {
      const failure = failureCategory(error);
      traces.push(
        failedAttemptTrace(
          agent,
          request,
          attempt,
          performance.now() - startedAt,
          failure,
          error instanceof AgentDecisionError ? error.usage : undefined,
        ),
      );
      if (failure === "cancellation-timeout") unavailableAgents.add(agent);
    }
  }

  const action = canonicalActions[0];
  if (action === undefined) {
    throw new HarnessError({ message: "The active player has no legal action." });
  }
  traces.push({
    ...baseTrace(agent, request, maxAttempts + 1, "fallback", 0),
    actionId: action.id,
  });
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
): NegotiationTrace => ({
  ...negotiationTraceBase(agent, request, attempt, "failed", elapsedMs),
  failure: failureCategory(error),
  ...(error instanceof AgentDecisionError && error.usage !== undefined
    ? { usage: error.usage }
    : {}),
});

const availableAttemptCount = (
  unavailableAgents: WeakSet<SeatAgent>,
  agent: SeatAgent,
  maxAttempts: number,
): number => (unavailableAgents.has(agent) ? 0 : maxAttempts);

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
): Promise<NegotiationChoice> => {
  const request: Omit<AgentNegotiationRequest, "signal"> = {
    matchId: state.matchId,
    gameSequence: state.sequence,
    playerId: player.id,
    turnPlayerId: session.turnPlayerId,
    round,
    observation: structuredClone(observe(state, { type: "player", playerId: player.id })),
    negotiation: structuredClone(
      projectNegotiation(
        session,
        { type: "player", playerId: player.id },
        { currentWindowOffersOnly: true },
      ),
    ),
  };
  const traces: NegotiationTrace[] = [];
  const attemptCount = availableAttemptCount(unavailableAgents, agent, maxAttempts);
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const startedAt = performance.now();
    try {
      const decision = await timeoutNegotiation(agent, structuredClone(request), timeoutMs);
      const applied = await Effect.runPromise(
        applyNegotiationAction(state, session, round, player.id, decision.action),
      );
      traces.push(
        selectedNegotiationTrace(agent, request, decision, attempt, performance.now() - startedAt),
      );
      return { applied, traces };
    } catch (error) {
      const failure = failureCategory(error);
      if (failure === "cancellation-timeout") unavailableAgents.add(agent);
      traces.push(
        failedNegotiationTrace(agent, request, error, attempt, performance.now() - startedAt),
      );
    }
  }
  const applied = await applyNegotiationFallback(state, session, round, player.id);
  traces.push({
    ...negotiationTraceBase(agent, request, maxAttempts + 1, "fallback", 0),
    actionType: "pass",
  });
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
    const choice = await chooseNegotiationAction(
      state,
      session,
      round,
      player,
      agent,
      timeoutMs,
      maxAttempts,
      unavailableAgents,
    );
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
): Promise<NegotiationWindowResult> => {
  let state = stateAtOpen;
  const historicalEventCount = history?.events.length ?? 0;
  let session = await Effect.runPromise(
    openNegotiationWindow(state, policy, initialNegotiationSequence, history ?? undefined),
  );
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
    );
    state = result.state;
    session = result.session;
    gameEvents.push(...result.gameEvents);
    traces.push(...result.traces);
    if (result.passes === order.length) {
      session = closeNegotiationWindow(state, session, "all-passed");
      return {
        state,
        session,
        events: gameEvents,
        negotiationEvents: session.events.slice(historicalEventCount),
        traces,
      };
    }
  }

  session = closeNegotiationWindow(state, session, "round-limit");
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
  );
  run.negotiatedTurns.add(state.phase.turn);
  run.events.push(...negotiated.events);
  run.negotiations.push(...negotiated.negotiationEvents);
  run.negotiationSession = negotiated.session;
  run.negotiationDecisions.push(...negotiated.traces);
  return negotiated.state;
};

const runWithAgents = async (
  options: AgentRunOptions,
  agents: ReadonlyMap<string, SeatAgent>,
  shouldContinue: (state: GameState, decisionCount: number) => boolean,
  allowNoLegalActions: boolean,
): Promise<MatchRunResult> => {
  const timeoutMs = options.decisionTimeoutMs ?? 90_000;
  const maxAttempts = options.maxAttempts ?? 1;
  positiveInteger(timeoutMs, "decisionTimeoutMs", MAX_TIMER_DELAY_MS);
  positiveInteger(maxAttempts, "maxAttempts");

  const created = await Effect.runPromise(createGame(options.config));
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const negotiations: NegotiationEvent[] = [];
  const decisions: DecisionTrace[] = [];
  const negotiationDecisions: NegotiationTrace[] = [];
  const unavailableAgents = new WeakSet<SeatAgent>();
  const negotiatedTurns = new Set<number>();
  const runNegotiationState: RunNegotiationState = {
    events,
    negotiations,
    negotiationSession: null,
    negotiationDecisions,
    negotiatedTurns,
  };
  let decisionCount = 0;

  while (shouldContinue(state, decisionCount)) {
    state = await negotiateCurrentTurn(
      state,
      options,
      agents,
      runNegotiationState,
      timeoutMs,
      maxAttempts,
      unavailableAgents,
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
        observation: structuredClone(observe(state, { type: "player", playerId: activePlayer.id })),
        legalActions: structuredClone(actions),
      },
      actions,
      unavailableAgents,
      timeoutMs,
      maxAttempts,
    );
    decisions.push(...chosen.traces);
    const result = await Effect.runPromise(handleCommand(state, chosen.action.command));
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
): Effect.Effect<InitialPlacementResult, HarnessError> =>
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
          error instanceof HarnessError
            ? error
            : new HarnessError({ message: "The initial-placement match failed." }),
      }),
    (agents) => Effect.promise(async () => disposeAgents(agents)),
  );

export const runGameSteps = (
  options: GameStepOptions,
): Effect.Effect<MatchRunResult, HarnessError> => {
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
          error instanceof HarnessError
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
