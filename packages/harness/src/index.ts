import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import type {
  GameConfig,
  GameEvent,
  GameObservation,
  GameState,
  LegalAction,
  PlayerConfig,
} from "@catanarchy/protocol";
import { Data, Effect } from "effect";

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

export interface SeatAgent {
  readonly model?: AgentModelIdentity;
  decide(request: AgentDecisionRequest): Promise<AgentDecision>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export type SeatAgentFactory = (player: PlayerConfig) => Promise<SeatAgent>;

export type DecisionFailure = "agent-error" | "deadline" | "invalid-action";

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

export interface InitialPlacementResult {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly decisions: ReadonlyArray<DecisionTrace>;
}

export interface InitialPlacementOptions {
  readonly config: GameConfig;
  readonly createAgent: SeatAgentFactory;
  readonly decisionTimeoutMs?: number;
  readonly maxAttempts?: number;
}

export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
}> {}

export class AgentDecisionError extends Data.TaggedError("AgentDecisionError")<{
  readonly message: string;
  readonly usage?: AgentUsage;
}> {}

const disposeAgents = async (agents: ReadonlyMap<string, SeatAgent>): Promise<void> => {
  await Promise.allSettled([...agents.values()].map(async (agent) => agent.dispose()));
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

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HarnessError({ message: `${name} must be a positive integer.` });
  }
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
      controller.abort();
      reject(new HarnessError({ message: "decision-deadline" }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([agent.decide({ ...request, signal: controller.signal }), deadline]);
  } catch (error) {
    if (controller.signal.aborted) {
      await agent.cancel();
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const failureCategory = (error: unknown): DecisionFailure =>
  error instanceof HarnessError && error.message === "decision-deadline"
    ? "deadline"
    : "agent-error";

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
  actionId: string,
  attempt: number,
  elapsedMs: number,
): DecisionTrace => ({
  ...baseTrace(agent, request, attempt, "selected", elapsedMs),
  actionId,
  ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  ...(decision.selectionMode === undefined ? {} : { selectionMode: decision.selectionMode }),
});

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
  timeoutMs: number,
  maxAttempts: number,
): Promise<ChosenAction> => {
  const traces: DecisionTrace[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = performance.now();
    try {
      const decision = await timeoutDecision(agent, request, timeoutMs);
      const action = request.legalActions.find(({ id }) => id === decision.actionId);
      const elapsedMs = performance.now() - startedAt;
      if (action !== undefined) {
        traces.push(selectedTrace(agent, request, decision, action.id, attempt, elapsedMs));
        return { action, traces };
      }
      traces.push(invalidActionTrace(agent, request, decision, attempt, elapsedMs));
    } catch (error) {
      traces.push(
        failedAttemptTrace(
          agent,
          request,
          attempt,
          performance.now() - startedAt,
          failureCategory(error),
          error instanceof AgentDecisionError ? error.usage : undefined,
        ),
      );
    }
  }

  const action = request.legalActions[0];
  if (action === undefined) {
    throw new HarnessError({ message: "The active player has no legal action." });
  }
  traces.push({
    ...baseTrace(agent, request, maxAttempts + 1, "fallback", 0),
    actionId: action.id,
  });
  return { action, traces };
};

const runWithAgents = async (
  options: InitialPlacementOptions,
  agents: ReadonlyMap<string, SeatAgent>,
): Promise<InitialPlacementResult> => {
  const timeoutMs = options.decisionTimeoutMs ?? 90_000;
  const maxAttempts = options.maxAttempts ?? 1;
  positiveInteger(timeoutMs, "decisionTimeoutMs");
  positiveInteger(maxAttempts, "maxAttempts");

  const created = await Effect.runPromise(createGame(options.config));
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const decisions: DecisionTrace[] = [];

  while (state.phase.tag !== "turn.roll") {
    const activePlayer = options.config.players[state.phase.playerIndex];
    if (activePlayer === undefined) {
      throw new HarnessError({ message: "The active player index is invalid." });
    }
    const agent = agents.get(activePlayer.id);
    if (agent === undefined) {
      throw new HarnessError({ message: `No agent exists for player ${activePlayer.id}.` });
    }
    const actions = legalActions(state);
    if (actions.length === 0) {
      throw new HarnessError({ message: "The active player has no legal action." });
    }
    const chosen = await chooseAction(
      agent,
      {
        matchId: state.matchId,
        sequence: state.sequence,
        playerId: activePlayer.id,
        observation: observe(state, { type: "player", playerId: activePlayer.id }),
        legalActions: actions,
      },
      timeoutMs,
      maxAttempts,
    );
    decisions.push(...chosen.traces);
    const result = await Effect.runPromise(handleCommand(state, chosen.action.command));
    state = result.state;
    events.push(...result.events);
  }

  return { state, events, decisions };
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
        try: async () => runWithAgents(options, agents),
        catch: (error) =>
          error instanceof HarnessError
            ? error
            : new HarnessError({ message: "The initial-placement match failed." }),
      }),
    (agents) => Effect.promise(async () => disposeAgents(agents)),
  );

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
