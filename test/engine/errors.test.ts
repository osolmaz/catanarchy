import { createGame, handleCommand, legalActions, replay } from "@catanarchy/engine";
import type {
  GameCommand,
  GameCommandPayload,
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

const commandEnvelope = (
  state: GameState,
  playerId: string,
  commandId: string,
  command: GameCommandPayload,
): GameCommand => ({
  schema: "catanarchy.command.v1",
  matchId: state.matchId,
  commandId,
  playerId,
  expectedSequence: state.sequence,
  command,
});

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
  it("rejects stale, wrong-match, wrong-player, and malformed commands", () => {
    const state = Effect.runSync(createGame(config())).state;
    const action = legalActions(state)[0]!;
    const malformed = {
      ...action.command,
      command: { type: "place-anywhere" },
    } as unknown as GameCommand;

    expect(failureCode(state, { ...action.command, matchId: "another-match" })).toBe("wrong-match");
    expect(failureCode(state, { ...action.command, expectedSequence: 99 })).toBe("stale-command");
    expect(failureCode(state, { ...action.command, playerId: "blue" })).toBe("wrong-player");
    expect(failureCode(state, malformed)).toBe("invalid-command");
  });

  it("rejects an unknown settlement and a road in the wrong phase", () => {
    const state = Effect.runSync(createGame(config())).state;
    expect(
      failureCode(
        state,
        commandEnvelope(state, "red", "unknown-vertex", {
          type: "place-initial-settlement",
          vertexId: "v:99:99",
        }),
      ),
    ).toBe("unknown-location");
    expect(
      failureCode(
        state,
        commandEnvelope(state, "red", "early-road", {
          type: "place-initial-road",
          edgeId: state.topology.edges[0]!.id,
        }),
      ),
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

    expect(
      failureCode(
        redRoadPhase,
        commandEnvelope(redRoadPhase, "red", "unknown", {
          type: "place-initial-road",
          edgeId: "e:v:90:90|v:91:91",
        }),
      ),
    ).toBe("unknown-location");
    expect(
      failureCode(
        redRoadPhase,
        commandEnvelope(redRoadPhase, "red", "remote", {
          type: "place-initial-road",
          edgeId: remoteEdge.id,
        }),
      ),
    ).toBe("road-not-adjacent");

    const redRoadAction = legalActions(redRoadPhase)[0]!;
    const blueSettlementPhase = Effect.runSync(
      handleCommand(redRoadPhase, redRoadAction.command),
    ).state;
    const blueSettlementAction = legalActions(blueSettlementPhase)[0]!;
    const blueRoadPhase = Effect.runSync(
      handleCommand(blueSettlementPhase, blueSettlementAction.command),
    ).state;
    const road = redRoadAction.command.command;
    expect(
      failureCode(
        blueRoadPhase,
        commandEnvelope(blueRoadPhase, "blue", "occupied", {
          type: "place-initial-road",
          edgeId: road.type === "place-initial-road" ? road.edgeId : remoteEdge.id,
        }),
      ),
    ).toBe("occupied-edge");
  });

  it("rejects occupied and adjacent settlement vertices", () => {
    const initial = Effect.runSync(createGame(config())).state;
    const redSettlementAction = legalActions(initial)[0]!;
    const redRoadPhase = Effect.runSync(handleCommand(initial, redSettlementAction.command)).state;
    const redRoad = legalActions(redRoadPhase)[0]!;
    const blueState = Effect.runSync(handleCommand(redRoadPhase, redRoad.command)).state;
    const settlement = redSettlementAction.command.command;
    if (settlement.type !== "place-initial-settlement") throw new Error("Expected settlement.");
    const redVertexId = settlement.vertexId;
    const redVertex = blueState.topology.vertices.find(({ id }) => id === redVertexId)!;

    expect(
      failureCode(
        blueState,
        commandEnvelope(blueState, "blue", "occupied", {
          type: "place-initial-settlement",
          vertexId: redVertexId,
        }),
      ),
    ).toBe("occupied-vertex");
    expect(
      failureCode(
        blueState,
        commandEnvelope(blueState, "blue", "adjacent", {
          type: "place-initial-settlement",
          vertexId: redVertex.adjacentVertexIds[0]!,
        }),
      ),
    ).toBe("settlement-too-close");
  });
});

describe("replay failures", () => {
  it("requires a decodable game.created event at sequence zero", () => {
    expect(Either.isLeft(Effect.runSync(Effect.either(replay([]))))).toBe(true);
    expect(
      Either.isLeft(
        Effect.runSync(
          Effect.either(
            replay([
              {
                schema: "catanarchy.game-event.v1",
                matchId: "errors",
                sequence: 0,
                commandId: "malformed",
              },
            ]),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("rejects forged initial state and event payloads", () => {
    const created = Effect.runSync(createGame(config()));
    const first = created.events[0];
    if (first.event.type !== "game.created") throw new Error("Expected game creation.");
    const forgedCreation = {
      ...first,
      event: {
        ...first.event,
        state: { ...first.event.state, bank: { ...first.event.state.bank, ore: 18 } },
      },
    } as GameEvent;
    const legal = legalActions(created.state)[0]!;
    const placed = Effect.runSync(handleCommand(created.state, legal.command)).events[0]!;
    const forgedCompletion = {
      ...placed,
      event: { type: "initial-placement.completed" },
    } as GameEvent;
    const forgedActor = {
      ...placed,
      event:
        placed.event.type === "settlement.placed"
          ? { ...placed.event, playerId: "blue" }
          : placed.event,
    } as GameEvent;

    expect(Either.isLeft(Effect.runSync(Effect.either(replay([forgedCreation]))))).toBe(true);
    expect(Either.isLeft(Effect.runSync(Effect.either(replay([first, forgedCompletion]))))).toBe(
      true,
    );
    expect(Either.isLeft(Effect.runSync(Effect.either(replay([first, forgedActor]))))).toBe(true);
  });

  it("rejects a sequence gap, a wrong match, and a second creation event", () => {
    const created = Effect.runSync(createGame(config()));
    const state = applyFirstAction(created.state);
    const settlement = legalActions(created.state)[0]!;
    const event = Effect.runSync(handleCommand(created.state, settlement.command)).events[0]!;
    const gap = { ...event, sequence: 3 } as GameEvent;
    const wrongMatch = { ...event, matchId: "another-match" } as GameEvent;

    expect(Either.isLeft(Effect.runSync(Effect.either(replay([created.events[0], gap]))))).toBe(
      true,
    );
    expect(
      Either.isLeft(Effect.runSync(Effect.either(replay([created.events[0], wrongMatch])))),
    ).toBe(true);
    expect(
      Either.isLeft(Effect.runSync(Effect.either(replay([created.events[0], created.events[0]])))),
    ).toBe(true);
    expect(state.sequence).toBe(1);
  });
});
