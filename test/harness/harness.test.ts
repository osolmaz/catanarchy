import { replay } from "@catanarchy/engine";
import {
  AgentDecisionError,
  AgentRunAbort,
  createFirstLegalAgent,
  runGameSteps,
  runInitialPlacement,
  type AgentDecisionRequest,
  type AgentNegotiationRequest,
  type MatchActivity,
  type SeatAgent,
} from "@catanarchy/harness";
import type {
  Building,
  GameConfig,
  LegalAction,
  NegotiationAction,
  PlayerColor,
  Resource,
  ResourceCounts,
} from "@catanarchy/protocol";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const COLORS: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];
const config = (playerCount = 4): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: `harness-${playerCount}`,
  seed: 42,
  players: COLORS.slice(0, playerCount).map((color) => ({ id: color, name: color, color })),
});

const inertAgent = (decide: SeatAgent["decide"]): SeatAgent => ({
  decide,
  async cancel() {},
  async dispose() {},
});

const firstAction = (request: AgentDecisionRequest) => {
  const action = request.legalActions[0];
  if (action === undefined) throw new Error("Expected a legal action.");
  return action;
};

const actionOfType = (
  request: AgentDecisionRequest,
  type: LegalAction["command"]["command"]["type"],
): LegalAction | undefined =>
  request.legalActions.find(({ command }) => command.command.type === type);

const setupSettlementScore = (request: AgentDecisionRequest, action: LegalAction): number => {
  const payload = action.command.command;
  if (payload.type !== "place-initial-settlement") return -1;
  const vertex = request.observation.topology.vertices.find(({ id }) => id === payload.vertexId)!;
  const numbers = new Map(
    request.observation.layout.numbers.map(({ hexId, number }) => [hexId, number]),
  );
  return vertex.adjacentHexIds.reduce((score, hexId) => {
    const number = numbers.get(hexId);
    return score + (number === undefined ? 0 : 6 - Math.abs(7 - number));
  }, 0);
};

const savesForSettlement = (request: AgentDecisionRequest): boolean => {
  const resources = request.observation.ownResources!;
  return (
    resources.lumber >= 2 && resources.brick >= 2 && resources.wool >= 1 && resources.grain >= 1
  );
};

const neededResources = (request: AgentDecisionRequest): ReadonlyArray<Resource> => {
  const resources = request.observation.ownResources!;
  const needs: Resource[] = [];
  if (resources.grain < 2) needs.push("grain");
  if (resources.ore < 3) needs.push("ore");
  if (resources.wool < 1) needs.push("wool");
  if (resources.lumber < 1) needs.push("lumber");
  if (resources.brick < 1) needs.push("brick");
  return needs;
};

const firstNeededTrade = (request: AgentDecisionRequest): LegalAction | undefined => {
  for (const receive of neededResources(request)) {
    const trade = request.legalActions.find(
      ({ command }) =>
        command.command.type === "maritime-trade" && command.command.receive === receive,
    );
    if (trade !== undefined) return trade;
  }
  return undefined;
};

const actionPhaseChoice = (request: AgentDecisionRequest): LegalAction => {
  const city = actionOfType(request, "build-city");
  if (city !== undefined) return city;
  const settlement = actionOfType(request, "build-settlement");
  if (settlement !== undefined) return settlement;
  const road = actionOfType(request, "build-road");
  if (road !== undefined && savesForSettlement(request)) return road;
  const developmentCard = actionOfType(request, "buy-development-card");
  if (developmentCard !== undefined) return developmentCard;
  return firstNeededTrade(request) ?? actionOfType(request, "end-turn")!;
};

const EMPTY_RESOURCES: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const RESOURCE_KEYS: ReadonlyArray<Resource> = ["lumber", "brick", "wool", "grain", "ore"];

const firstHeldResource = (
  resources: ResourceCounts | null,
  excluded?: Resource,
): Resource | undefined =>
  resources === null
    ? undefined
    : RESOURCE_KEYS.find((resource) => resource !== excluded && resources[resource] > 0);

const canPayBundle = (resources: ResourceCounts | null, needed: ResourceCounts): boolean =>
  resources !== null && RESOURCE_KEYS.every((resource) => resources[resource] >= needed[resource]);

const targetedBargainingAction = (
  request: AgentNegotiationRequest,
  markCompleted: () => void,
): NegotiationAction | undefined => {
  const targeted = request.negotiation.offers.find(
    ({ status, targetPlayerId }) => status === "open" && targetPlayerId === request.playerId,
  );
  if (targeted === undefined) return undefined;
  const own = request.observation.ownResources;
  if (canPayBundle(own, targeted.receive)) {
    markCompleted();
    return { type: "accept-offer", offerId: targeted.id };
  }
  const required = RESOURCE_KEYS.find((resource) => targeted.receive[resource] > 0);
  const counterGive = firstHeldResource(own, required);
  const counterReceive = RESOURCE_KEYS.find((resource) => targeted.give[resource] > 0);
  if (counterGive === undefined || counterReceive === undefined || counterGive === counterReceive) {
    return undefined;
  }
  return {
    type: "counter-offer",
    offerId: targeted.id,
    scope: { type: "direct", playerId: targeted.proposerPlayerId },
    give: { ...EMPTY_RESOURCES, [counterGive]: 1 },
    receive: { ...EMPTY_RESOURCES, [counterReceive]: 1 },
  };
};

const newBargainingOffer = (request: AgentNegotiationRequest): NegotiationAction | undefined => {
  if (request.round !== 2 || request.playerId !== request.turnPlayerId) return undefined;
  const give = firstHeldResource(request.observation.ownResources);
  const receive = RESOURCE_KEYS.find((resource) => resource !== give);
  const target = request.observation.players.find(({ id }) => id !== request.playerId);
  if (give === undefined || receive === undefined || target === undefined) return undefined;
  return {
    type: "make-offer",
    targetPlayerId: target.id,
    scope: { type: "direct", playerId: target.id },
    give: { ...EMPTY_RESOURCES, [give]: 1 },
    receive: { ...EMPTY_RESOURCES, [receive]: 1 },
  };
};

const bargainingAction = (
  request: AgentNegotiationRequest,
  markCompleted: () => void,
): NegotiationAction => {
  if (request.round === 1) {
    return {
      type: "send-message",
      scope: { type: "public" },
      text: `${request.playerId} is open to a fair resource trade.`,
    };
  }
  return (
    targetedBargainingAction(request, markCompleted) ??
    newBargainingOffer(request) ?? { type: "pass" }
  );
};

const scoringAction = (request: AgentDecisionRequest): LegalAction => {
  if (request.observation.phase.tag === "setup.settlement") {
    return request.legalActions.toSorted(
      (left, right) => setupSettlementScore(request, right) - setupSettlementScore(request, left),
    )[0]!;
  }
  if (request.observation.phase.tag === "turn.roll") {
    return actionOfType(request, "roll-dice")!;
  }
  if (request.observation.phase.tag === "turn.action") return actionPhaseChoice(request);
  return (
    request.legalActions.find(({ command }) => !command.command.type.startsWith("play-")) ??
    firstAction(request)
  );
};

describe("agent harness", () => {
  it("stops a match when an agent aborts the complete run", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runGameSteps({
          config: config(4),
          maxDecisions: 1,
          createAgent: async () =>
            inertAgent(async () => {
              throw new AgentRunAbort({ message: "stop the run" });
            }),
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentRunAbort);
  });

  it("stops a match when negotiation aborts the complete run", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runGameSteps({
          config: config(4),
          maxDecisions: 30,
          negotiationPolicy: { maxRounds: 1, maxMessageLength: 160, maxOpenOffers: 4 },
          createAgent: async () => ({
            async decide(request) {
              return { actionId: firstAction(request).id };
            },
            async negotiate() {
              throw new AgentRunAbort({ message: "stop the run" });
            },
            async cancel() {},
            async dispose() {},
          }),
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentRunAbort);
  });

  it("runs a bounded normal-turn step after setup", async () => {
    const gameConfig: GameConfig = { ...config(4), seed: 0, matchId: "harness-steps" };
    const result = await Effect.runPromise(
      runGameSteps({
        config: gameConfig,
        maxDecisions: 17,
        createAgent: async () => createFirstLegalAgent(),
      }),
    );

    expect(result.decisions).toHaveLength(17);
    expect(result.events.some(({ event }) => event.type === "dice.rolled")).toBe(true);
    expect(result.state.phase.tag).toBe("turn.action");
  });

  it("continues through robber movement after a seven", async () => {
    const result = await Effect.runPromise(
      runGameSteps({
        config: config(4),
        maxDecisions: 20,
        createAgent: async () => createFirstLegalAgent(),
      }),
    );

    expect(result.decisions).toHaveLength(20);
    expect(result.events.some(({ event }) => event.type === "robber.moved")).toBe(true);
  });

  it("completes and replays a full deterministic native game after multi-round bargaining", async () => {
    let completedTrade = false;
    let sawCurrentWindow = false;
    let sawPriorClosedWindow = false;
    const result = await Effect.runPromise(
      runGameSteps({
        config: { ...config(4), seed: 43, matchId: "harness-complete-game" },
        maxDecisions: 2_000,
        negotiationPolicy: { maxRounds: 3, maxMessageLength: 160, maxOpenOffers: 4 },
        createAgent: async () => ({
          async decide(request) {
            return { actionId: scoringAction(request).id };
          },
          async negotiate(request) {
            if (
              request.negotiation.events.some(
                ({ event }) => event.type === "negotiation.window-opened",
              )
            ) {
              sawCurrentWindow = true;
            }
            if (
              request.negotiation.events.some(
                ({ event }) => event.type === "negotiation.window-closed",
              )
            ) {
              sawPriorClosedWindow = true;
            }
            return {
              action: completedTrade
                ? { type: "pass" }
                : bargainingAction(request, () => {
                    completedTrade = true;
                  }),
            };
          },
          async cancel() {},
          async dispose() {},
        }),
      }),
    );

    expect(result.decisions.length).toBeLessThan(2_000);
    expect(result.state.phase.tag).toBe("game.finished");
    expect(result.state.result).toMatchObject({ victoryPoints: 10 });
    expect(result.events.at(-1)?.event.type).toBe("game.won");
    expect(result.events.some(({ event }) => event.type === "domestic-trade.completed")).toBe(true);
    expect(result.negotiations.some(({ event }) => event.type === "negotiation.message-sent")).toBe(
      true,
    );
    expect(result.negotiations.some(({ event }) => event.type === "trade.offer-created")).toBe(
      true,
    );
    expect(result.negotiations.some(({ event }) => event.type === "trade.offer-accepted")).toBe(
      true,
    );
    expect(
      Math.max(
        ...result.negotiations.flatMap(({ event }) => ("round" in event ? [event.round] : [])),
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(result.negotiationSession?.closed).toBe(true);
    expect(sawCurrentWindow).toBe(true);
    expect(sawPriorClosedWindow).toBe(false);
    expect(result.negotiations.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: result.negotiations.length }, (_value, sequence) => sequence),
    );
    expect(Effect.runSync(replay(result.events))).toEqual(result.state);
  }, 20_000);

  it("keeps private discard choices out of decision traces", async () => {
    const result = await Effect.runPromise(
      runGameSteps({
        config: { ...config(4), seed: 9, matchId: "harness-private-discards" },
        maxDecisions: 300,
        createAgent: async () =>
          inertAgent(async (request) => {
            const action =
              request.observation.phase.tag === "turn.action"
                ? (request.legalActions.find(({ id }) => id === "end-turn") ?? firstAction(request))
                : firstAction(request);
            return {
              actionId: action.id,
              reason: `Private choice: ${JSON.stringify(action.command.command)}`,
            };
          }),
      }),
    );
    const discardTraces = result.decisions.filter(({ actionId }) =>
      actionId?.startsWith("private-option:"),
    );

    expect(result.events.some(({ event }) => event.type === "resource.discarded")).toBe(true);
    expect(discardTraces.length).toBeGreaterThan(0);
    expect(discardTraces.every(({ reason }) => reason === undefined)).toBe(true);
    expect(JSON.stringify(discardTraces)).not.toMatch(/lumber|brick|wool|grain|ore/);
  });

  it("rejects an invalid game-step limit before creating agents", async () => {
    const createAgent = vi.fn<() => Promise<SeatAgent>>(async () => createFirstLegalAgent());
    await expect(
      Effect.runPromise(runGameSteps({ config: config(3), maxDecisions: 0, createAgent })),
    ).rejects.toThrow("maxDecisions must be a positive integer");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it.each([3, 4])("completes setup with one persistent agent per %i seats", async (count) => {
    const createdPlayers: string[] = [];
    const calls = new Map<string, number>();
    const turnKeys = new Map<string, string[]>();
    const disposed: string[] = [];

    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(count),
        createAgent: async (player) => {
          createdPlayers.push(player.id);
          return {
            async decide(request) {
              calls.set(player.id, (calls.get(player.id) ?? 0) + 1);
              turnKeys.set(player.id, [...(turnKeys.get(player.id) ?? []), request.turnKey]);
              expect(request.playerId).toBe(player.id);
              expect(request.observation.ownResources).not.toBeNull();
              expect(request.observation.ownDevelopmentCards).not.toBeNull();
              expect(request.observation.ownVictoryPoints).not.toBeNull();
              expect("developmentDeck" in request.observation).toBe(false);
              return { actionId: firstAction(request).id };
            },
            async cancel() {},
            async dispose() {
              disposed.push(player.id);
            },
          };
        },
      }),
    );

    expect(createdPlayers).toEqual(config(count).players.map(({ id }) => id));
    expect(disposed.toSorted()).toEqual(createdPlayers.toSorted());
    expect([...calls.values()]).toEqual(Array.from({ length: count }, () => 4));
    for (const [playerIndex, player] of config(count).players.entries()) {
      expect(turnKeys.get(player.id)).toEqual([
        `setup:forward:${String(playerIndex)}`,
        `setup:forward:${String(playerIndex)}`,
        `setup:reverse:${String(playerIndex)}`,
        `setup:reverse:${String(playerIndex)}`,
      ]);
    }
    expect(result.state.phase.tag).toBe("turn.roll");
    expect(result.state.occupancy.buildings).toHaveLength(count * 2);
    expect(result.state.occupancy.roads).toHaveLength(count * 2);
    expect(result.decisions).toHaveLength(count * 4);
    expect(result.decisions.every(({ outcome }) => outcome === "selected")).toBe(true);
  });

  it("reports requests, decisions, and complete game-event batches in order", async () => {
    const activities: MatchActivity[] = [];
    const result = await Effect.runPromise(
      runGameSteps({
        config: config(3),
        maxDecisions: 1,
        createAgent: async () => createFirstLegalAgent(),
        onActivity(activity) {
          activities.push(activity);
        },
      }),
    );

    expect(activities.map(({ kind }) => kind)).toEqual([
      "game.event",
      "game.command-completed",
      "game.agent-requested",
      "game.decision",
      "game.event",
      "game.command-completed",
    ]);
    expect(activities.find(({ kind }) => kind === "game.agent-requested")).toMatchObject({
      payload: {
        attempt: 1,
        request: { playerId: "red", sequence: 0, turnKey: "setup:forward:0" },
      },
    });
    expect(
      activities.filter(({ kind }) => kind === "game.event").map(({ payload }) => payload),
    ).toEqual(result.events);
  });

  it("reports each negotiation request, decision, and event as it happens", async () => {
    const activities: MatchActivity[] = [];
    await Effect.runPromise(
      runGameSteps({
        config: config(4),
        maxDecisions: 19,
        negotiationPolicy: { maxRounds: 1, maxMessageLength: 100, maxOpenOffers: 2 },
        createAgent: async () => createFirstLegalAgent(),
        onActivity(activity) {
          activities.push(activity);
        },
      }),
    );

    const negotiationActivities = activities.filter(({ kind }) => kind.startsWith("negotiation."));
    expect(negotiationActivities.map(({ kind }) => kind)).toEqual([
      "negotiation.event",
      "negotiation.agent-requested",
      "negotiation.decision",
      "negotiation.event",
      "negotiation.agent-requested",
      "negotiation.decision",
      "negotiation.event",
      "negotiation.agent-requested",
      "negotiation.decision",
      "negotiation.event",
      "negotiation.agent-requested",
      "negotiation.decision",
      "negotiation.event",
      "negotiation.event",
    ]);
    const negotiationTurnKeys = negotiationActivities.flatMap((activity) =>
      activity.kind === "negotiation.agent-requested" ? [activity.payload.request.turnKey] : [],
    );
    expect(new Set(negotiationTurnKeys)).toEqual(new Set(["turn:1"]));
  });

  it("records model identity, reasons, and usage", async () => {
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        createAgent: async () => ({
          model: { provider: "test", modelId: "test-model" },
          async decide(request) {
            return {
              actionId: firstAction(request).id,
              reason: "A concise reason.",
              selectionMode: "tool",
              usage: {
                input: 10,
                output: 2,
                cacheRead: 1,
                cacheWrite: 0,
                total: 13,
                cost: 0.001,
              },
            };
          },
          async cancel() {},
          async dispose() {},
        }),
      }),
    );

    expect(result.decisions[0]).toMatchObject({
      model: { provider: "test", modelId: "test-model" },
      reason: "A concise reason.",
      usage: { total: 13 },
      selectionMode: "tool",
    });
  });

  it("protects authoritative state and actions from agent mutation", async () => {
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        createAgent: async () =>
          inertAgent(async (request) => {
            const action = firstAction(request);
            (request.observation.occupancy.buildings as Building[]).push({
              vertexId: "v:999:999",
              playerId: "red",
              kind: "settlement",
            });
            (request.legalActions as LegalAction[]).length = 0;
            return { actionId: action.id };
          }),
      }),
    );

    expect(result.state.phase.tag).toBe("turn.roll");
    expect(result.state.occupancy.buildings).toHaveLength(6);
    expect(result.state.occupancy.buildings).not.toContainEqual({
      vertexId: "v:999:999",
      playerId: "red",
      kind: "settlement",
    });
  });

  it("falls back to the first legal action after an invalid selection", async () => {
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        createAgent: async () => inertAgent(async () => ({ actionId: "not-legal" })),
      }),
    );

    expect(result.state.phase.tag).toBe("turn.roll");
    expect(result.decisions.slice(0, 2).map(({ outcome }) => outcome)).toEqual([
      "failed",
      "fallback",
    ]);
    expect(result.decisions[0]?.failure).toBe("invalid-action");
    expect(result.decisions[1]?.actionId).toMatch(/^settlement:/);
  });

  it("records usage from a completed model decision that has no valid selection", async () => {
    const usage = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 0,
      total: 160,
      cost: 0.01,
    };
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        createAgent: async () =>
          inertAgent(async () => {
            throw new AgentDecisionError({ message: "No selection.", usage });
          }),
      }),
    );

    expect(result.decisions[0]).toMatchObject({
      outcome: "failed",
      failure: "agent-error",
      usage,
    });
  });

  it("retries a failed decision only up to the configured limit", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        maxAttempts: 2,
        createAgent: async () =>
          inertAgent(async (request) => {
            calls += 1;
            if (calls === 1) throw new Error("provider failed");
            return { actionId: firstAction(request).id };
          }),
      }),
    );

    expect(result.decisions[0]).toMatchObject({
      attempt: 1,
      outcome: "failed",
      failure: "agent-error",
    });
    expect(result.decisions[1]).toMatchObject({ attempt: 2, outcome: "selected" });
    expect(result.state.phase.tag).toBe("turn.roll");
  });

  it("cancels a deadline expiry and uses the deterministic fallback", async () => {
    const cancel = vi.fn<SeatAgent["cancel"]>(async () => {});
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        decisionTimeoutMs: 1,
        createAgent: async () => ({
          async decide(request) {
            return new Promise((resolve) => {
              request.signal.addEventListener(
                "abort",
                () => resolve({ actionId: firstAction(request).id }),
                { once: true },
              );
            });
          },
          cancel,
          async dispose() {},
        }),
      }),
    );

    expect(cancel).toHaveBeenCalledTimes(12);
    expect(result.decisions[0]).toMatchObject({ outcome: "failed", failure: "deadline" });
    expect(result.decisions[1]).toMatchObject({ outcome: "fallback" });
  });

  it("quarantines an agent when cancellation rejects and its decision does not settle", async () => {
    const cancel = vi.fn<SeatAgent["cancel"]>(async () => {
      throw new Error("cancel failed");
    });
    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(3),
        decisionTimeoutMs: 1,
        maxAttempts: 2,
        createAgent: async (player) =>
          player.id === "red"
            ? {
                async decide() {
                  return new Promise<never>(() => {});
                },
                cancel,
                async dispose() {},
              }
            : createFirstLegalAgent(),
      }),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.decisions[0]).toMatchObject({
      outcome: "failed",
      failure: "cancellation-timeout",
    });
    expect(
      result.decisions.filter(
        ({ playerId, outcome }) => playerId === "red" && outcome === "fallback",
      ),
    ).toHaveLength(4);
    expect(result.state.phase.tag).toBe("turn.roll");
  });

  it("quarantines an agent when negotiation cancellation rejects", async () => {
    const cancel = vi.fn<SeatAgent["cancel"]>(async () => {
      throw new Error("cancel failed");
    });
    const negotiate = vi.fn<NonNullable<SeatAgent["negotiate"]>>(
      async (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve({ action: { type: "pass" } }), {
            once: true,
          });
        }),
    );
    const result = await Effect.runPromise(
      runGameSteps({
        config: config(3),
        maxDecisions: 30,
        decisionTimeoutMs: 10,
        maxAttempts: 2,
        negotiationPolicy: { maxRounds: 1, maxMessageLength: 160, maxOpenOffers: 4 },
        createAgent: async (player) =>
          player.id === "red"
            ? {
                async decide(request) {
                  return { actionId: firstAction(request).id };
                },
                negotiate,
                cancel,
                async dispose() {},
              }
            : createFirstLegalAgent(),
      }),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(negotiate).toHaveBeenCalledOnce();
    const redTraces = result.negotiationDecisions.filter(({ playerId }) => playerId === "red");
    expect(redTraces[0]).toMatchObject({
      outcome: "failed",
      failure: "cancellation-timeout",
    });
    expect(redTraces.slice(1).every(({ outcome }) => outcome === "fallback")).toBe(true);
  });

  it("disposes agents that were created before factory failure", async () => {
    const dispose = vi.fn<SeatAgent["dispose"]>(async () => {});
    let count = 0;
    const effect = runInitialPlacement({
      config: config(3),
      createAgent: async () => {
        count += 1;
        if (count === 2) throw new Error("creation failed");
        return { ...createFirstLegalAgent(), dispose };
      },
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("An agent could not be created.");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("maps engine failures to a harness failure and disposes agents", async () => {
    const dispose = vi.fn<SeatAgent["dispose"]>(async () => {});
    const invalid = { ...config(3), seed: -1 };

    await expect(
      Effect.runPromise(
        runInitialPlacement({
          config: invalid,
          createAgent: async () => ({ ...createFirstLegalAgent(), dispose }),
        }),
      ),
    ).rejects.toThrow("The initial-placement match failed.");
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid decision limits before the first decision", async () => {
    await expect(
      Effect.runPromise(
        runInitialPlacement({
          config: config(3),
          decisionTimeoutMs: 0,
          createAgent: async () => createFirstLegalAgent(),
        }),
      ),
    ).rejects.toThrow("decisionTimeoutMs must be a positive integer");

    await expect(
      Effect.runPromise(
        runInitialPlacement({
          config: config(3),
          decisionTimeoutMs: 0x8000_0000,
          createAgent: async () => createFirstLegalAgent(),
        }),
      ),
    ).rejects.toThrow("decisionTimeoutMs must be a positive integer");

    await expect(
      Effect.runPromise(
        runInitialPlacement({
          config: config(3),
          maxAttempts: 0,
          createAgent: async () => createFirstLegalAgent(),
        }),
      ),
    ).rejects.toThrow("maxAttempts must be a positive integer");
  });

  it("rejects a scripted decision with no legal actions", async () => {
    const agent = createFirstLegalAgent();
    await expect(
      agent.decide({
        matchId: "empty",
        sequence: 0,
        playerId: "red",
        turnKey: "sequence:0",
        observation: {} as AgentDecisionRequest["observation"],
        legalActions: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("no legal action");
  });
});
