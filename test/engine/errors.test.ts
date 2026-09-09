import { createGame, handleCommand, legalActions, replay } from "@catanarchy/engine";
import type {
  GameCommand,
  GameConfig,
  GameEvent,
  GameState,
  PlayerColor,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

const colors: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];
const config = (overrides: Partial<GameConfig> = {}): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: "errors",
  seed: 7,
  players: colors.map((color) => ({ id: color, name: color, color })),
  ...overrides,
});

const failureCode = (state: GameState, command: GameCommand): string => {
  const result = Effect.runSync(Effect.either(handleCommand(state, command)));
  if (Either.isRight(result)) throw new Error("Expected the command to fail.");
  return result.left.code;
};

const applyFirstAction = (state: GameState): GameState => {
  const action = legalActions(state)[0];
  if (action === undefined) throw new Error("Expected a legal action.");
  return Effect.runSync(handleCommand(state, action.command)).state;
};

describe("configuration failures", () => {
  it.each([
    { matchId: "", expected: "invalid-config" },
    { seed: -1, expected: "invalid-seed" },
    { seed: 1.5, expected: "invalid-seed" },
    { seed: 0x1_0000_0000, expected: "invalid-seed" },
    { players: config().players.slice(0, 2), expected: "invalid-player-count" },
    {
      players: [...config().players, { id: "fifth", name: "fifth", color: "red" as const }],
      expected: "invalid-player-count",
    },
    {
      players: config().players.map((player, index) =>
        index === 1 ? { ...player, id: "red" } : player,
      ),
      expected: "duplicate-player-id",
    },
    {
      players: config().players.map((player, index) =>
        index === 1 ? { ...player, color: "red" as const } : player,
      ),
      expected: "duplicate-player-color",
    },
  ])("rejects $expected", (example) => {
    const result = Effect.runSync(
      Effect.either(createGame(config(example as Partial<GameConfig>))),
    );
    expect(Either.isLeft(result) ? result.left.code : "success").toBe(example.expected);
  });
});

describe("command failures", () => {
  it("rejects stale and wrong-player commands", () => {
    const state = Effect.runSync(createGame(config())).state;
    const action = legalActions(state)[0]!;

    expect(failureCode(state, { ...action.command, expectedSequence: 99 })).toBe("stale-command");
    expect(failureCode(state, { ...action.command, playerId: "blue" })).toBe("wrong-player");
  });

  it("rejects an unknown settlement and a road in the wrong phase", () => {
    const state = Effect.runSync(createGame(config())).state;
    expect(
      failureCode(state, {
        type: "place-initial-settlement",
        commandId: "unknown-vertex",
        playerId: "red",
        expectedSequence: 0,
        vertexId: "v:99:99",
      }),
    ).toBe("unknown-location");
    expect(
      failureCode(state, {
        type: "place-initial-road",
        commandId: "early-road",
        playerId: "red",
        expectedSequence: 0,
        edgeId: state.topology.edges[0]!.id,
      }),
    ).toBe("wrong-command");
  });

  it("rejects unknown, occupied, and disconnected roads", () => {
    const initial = Effect.runSync(createGame(config())).state;
    const redRoadPhase = applyFirstAction(initial);
    const remoteEdge = redRoadPhase.topology.edges.find(
      (edge) =>
        redRoadPhase.phase.tag === "setup.road" &&
        !edge.vertexIds.includes(redRoadPhase.phase.settlementId),
    )!;
    const base = {
      type: "place-initial-road" as const,
      playerId: "red",
      expectedSequence: redRoadPhase.sequence,
    };

    expect(
      failureCode(redRoadPhase, { ...base, commandId: "unknown", edgeId: "e:v:90:90|v:91:91" }),
    ).toBe("unknown-location");
    expect(failureCode(redRoadPhase, { ...base, commandId: "remote", edgeId: remoteEdge.id })).toBe(
      "road-not-adjacent",
    );

    const redRoadAction = legalActions(redRoadPhase)[0]!;
    const blueSettlementPhase = Effect.runSync(
      handleCommand(redRoadPhase, redRoadAction.command),
    ).state;
    const blueSettlementAction = legalActions(blueSettlementPhase)[0]!;
    const blueRoadPhase = Effect.runSync(
      handleCommand(blueSettlementPhase, blueSettlementAction.command),
    ).state;
    expect(
      failureCode(blueRoadPhase, {
        type: "place-initial-road",
        commandId: "occupied",
        playerId: "blue",
        expectedSequence: blueRoadPhase.sequence,
        edgeId:
          redRoadAction.command.type === "place-initial-road"
            ? redRoadAction.command.edgeId
            : remoteEdge.id,
      }),
    ).toBe("occupied-edge");
  });

  it("rejects occupied and adjacent settlement vertices", () => {
    const initial = Effect.runSync(createGame(config())).state;
    const redSettlementAction = legalActions(initial)[0]!;
    const redRoadPhase = Effect.runSync(handleCommand(initial, redSettlementAction.command)).state;
    const redRoad = legalActions(redRoadPhase)[0]!;
    const blueState = Effect.runSync(handleCommand(redRoadPhase, redRoad.command)).state;
    if (redSettlementAction.command.type !== "place-initial-settlement")
      throw new Error("Expected settlement.");
    const redVertexId = redSettlementAction.command.vertexId;
    const redVertex = blueState.topology.vertices.find(({ id }) => id === redVertexId)!;
    const base = {
      type: "place-initial-settlement" as const,
      playerId: "blue",
      expectedSequence: blueState.sequence,
    };

    expect(
      failureCode(blueState, {
        ...base,
        commandId: "occupied",
        vertexId: redVertexId,
      }),
    ).toBe("occupied-vertex");
    expect(
      failureCode(blueState, {
        ...base,
        commandId: "adjacent",
        vertexId: redVertex.adjacentVertexIds[0]!,
      }),
    ).toBe("settlement-too-close");
  });
});

describe("replay failures", () => {
  it("requires game.created at sequence zero", () => {
    expect(Either.isLeft(Effect.runSync(Effect.either(replay([]))))).toBe(true);
  });

  it("rejects a sequence gap and a second creation event", () => {
    const created = Effect.runSync(createGame(config()));
    const state = applyFirstAction(created.state);
    const settlement = legalActions(created.state)[0]!;
    const event = Effect.runSync(handleCommand(created.state, settlement.command)).events[0]!;
    const gap = { ...event, sequence: 3 } as GameEvent;

    expect(Either.isLeft(Effect.runSync(Effect.either(replay([created.events[0], gap]))))).toBe(
      true,
    );
    expect(
      Either.isLeft(Effect.runSync(Effect.either(replay([created.events[0], created.events[0]])))),
    ).toBe(true);
    expect(state.sequence).toBe(1);
  });
});
