import {
  AgentDecisionError,
  createFirstLegalAgent,
  runInitialPlacement,
  type AgentDecisionRequest,
  type SeatAgent,
} from "@catanarchy/harness";
import type { Building, GameConfig, LegalAction, PlayerColor } from "@catanarchy/protocol";
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

describe("initial-placement harness", () => {
  it.each([3, 4])("completes setup with one persistent agent per %i seats", async (count) => {
    const createdPlayers: string[] = [];
    const calls = new Map<string, number>();
    const disposed: string[] = [];

    const result = await Effect.runPromise(
      runInitialPlacement({
        config: config(count),
        createAgent: async (player) => {
          createdPlayers.push(player.id);
          return {
            async decide(request) {
              calls.set(player.id, (calls.get(player.id) ?? 0) + 1);
              expect(request.playerId).toBe(player.id);
              expect(request.observation.ownResources).not.toBeNull();
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
    expect(result.state.phase.tag).toBe("turn.roll");
    expect(result.state.occupancy.buildings).toHaveLength(count * 2);
    expect(result.state.occupancy.roads).toHaveLength(count * 2);
    expect(result.decisions).toHaveLength(count * 4);
    expect(result.decisions.every(({ outcome }) => outcome === "selected")).toBe(true);
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

  it("quarantines an agent when cancellation does not settle", async () => {
    const cancel = vi.fn<SeatAgent["cancel"]>(async () => new Promise<void>(() => {}));
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
    ).rejects.toThrow("decisionTimeoutMs must be a positive integer.");

    await expect(
      Effect.runPromise(
        runInitialPlacement({
          config: config(3),
          maxAttempts: 0,
          createAgent: async () => createFirstLegalAgent(),
        }),
      ),
    ).rejects.toThrow("maxAttempts must be a positive integer.");
  });

  it("rejects a scripted decision with no legal actions", async () => {
    const agent = createFirstLegalAgent();
    await expect(
      agent.decide({
        matchId: "empty",
        sequence: 0,
        playerId: "red",
        observation: {} as AgentDecisionRequest["observation"],
        legalActions: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("no legal action");
  });
});
