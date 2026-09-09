import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { createGame } from "../src/engine/game.js";
import { decodeGameConfig, type GameConfig } from "../src/protocol/model.js";

const players: GameConfig["players"] = [
  { id: "red", name: "Red", color: "red" },
  { id: "blue", name: "Blue", color: "blue" },
  { id: "white", name: "White", color: "white" },
];

const config = (overrides: Partial<GameConfig> = {}): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  seed: 42,
  players,
  ...overrides,
});

const runEither = (gameConfig: GameConfig) => Effect.runSync(Effect.either(createGame(gameConfig)));

describe("createGame", () => {
  it("creates a deterministic initial-placement state", () => {
    const first = Effect.runSync(createGame(config()));
    const second = Effect.runSync(createGame(config()));

    expect(first).toEqual(second);
    expect(first.phase).toBe("initial-placement-forward");
    expect(first.players).toHaveLength(3);
    expect(first.events).toEqual([
      {
        sequence: 0,
        type: "game.created",
        seed: 42,
        players: [
          { id: "red", color: "red" },
          { id: "blue", color: "blue" },
          { id: "white", color: "white" },
        ],
      },
      {
        sequence: 1,
        type: "initial-placement.started",
        activePlayerId: "red",
        direction: "forward",
      },
    ]);
  });

  it.each([
    { players: players.slice(0, 2), code: "invalid-player-count" },
    {
      players: [
        ...players,
        { id: "orange", name: "Orange", color: "orange" },
        { id: "extra", name: "Extra", color: "red" },
      ],
      code: "invalid-player-count",
    },
    { seed: -1, code: "invalid-seed" },
    { seed: 1.5, code: "invalid-seed" },
    { seed: 0x1_0000_0000, code: "invalid-seed" },
    {
      players: [players[0]!, { ...players[1]!, id: players[0]!.id }, players[2]!],
      code: "duplicate-player-id",
    },
    {
      players: [players[0]!, { ...players[1]!, color: players[0]!.color }, players[2]!],
      code: "duplicate-player-color",
    },
  ])("rejects invalid configuration: $code", (override) => {
    const result = runEither(config(override as Partial<GameConfig>));

    if (Either.isRight(result)) {
      throw new Error("Expected the game configuration to fail.");
    }
    expect(result.left.code).toBe(override.code);
  });

  it("decodes unknown configuration through Effect Schema", () => {
    const result = Effect.runSync(decodeGameConfig(config()));

    expect(result.players[0]?.id).toBe("red");
  });

  it("rejects malformed boundary input", () => {
    const result = Effect.runSync(Effect.either(decodeGameConfig({ seed: "42" })));

    expect(Either.isLeft(result)).toBe(true);
  });
});
