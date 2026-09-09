import {
  decodeGameCommand,
  decodeGameConfig,
  decodeGameEventEnvelope,
  DEVELOPMENT_CARDS,
  GameConfigSchema,
  PLAYER_COLORS,
  RESOURCE_TYPES,
  TERRAIN_TYPES,
} from "@catanarchy/protocol";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("protocol boundaries", () => {
  it("decodes a valid game configuration", () => {
    const value = {
      schema: "catanarchy.game-config.v1",
      matchId: "protocol",
      seed: 42,
      players: [
        { id: "red", name: "Red", color: "red" },
        { id: "blue", name: "Blue", color: "blue" },
        { id: "white", name: "White", color: "white" },
      ],
    };

    expect(Effect.runSync(decodeGameConfig(value))).toEqual(value);
    expect(Schema.is(GameConfigSchema)(value)).toBe(true);
  });

  it("rejects malformed configuration data", () => {
    const result = Effect.runSync(Effect.either(decodeGameConfig({ seed: "42" })));
    expect(Either.isLeft(result)).toBe(true);
  });

  it("decodes a versioned, match-scoped command envelope", () => {
    const value = {
      schema: "catanarchy.command.v1",
      matchId: "protocol",
      commandId: "command-1",
      playerId: "red",
      expectedSequence: 0,
      command: { type: "place-initial-settlement", vertexId: "v:0:0" },
    };

    expect(Effect.runSync(decodeGameCommand(value))).toEqual(value);
    expect(
      Either.isLeft(
        Effect.runSync(
          Effect.either(decodeGameCommand({ ...value, schema: "catanarchy.command.v0" })),
        ),
      ),
    ).toBe(true);
  });

  it("decodes normal-turn commands and random outcome events", () => {
    const trade = {
      schema: "catanarchy.command.v1",
      matchId: "protocol",
      commandId: "trade-1",
      playerId: "red",
      expectedSequence: 20,
      command: { type: "maritime-trade", give: "lumber", receive: "ore" },
    };
    const roll = {
      schema: "catanarchy.game-event.v1",
      matchId: "protocol",
      commandId: "roll-1",
      sequence: 21,
      event: {
        type: "dice.rolled",
        playerId: "red",
        dice: [3, 4],
        nextRandom: { algorithm: "catanarchy-prng-v1", value: 7, draws: 2 },
        grants: [],
        shortages: [],
      },
    };

    expect(Effect.runSync(decodeGameCommand(trade))).toEqual(trade);
    expect(Effect.runSync(decodeGameEventEnvelope(roll))).toEqual(roll);
  });

  it("exports stable vocabulary", () => {
    expect(PLAYER_COLORS).toEqual(["red", "blue", "white", "orange"]);
    expect(RESOURCE_TYPES).toHaveLength(5);
    expect(TERRAIN_TYPES).toHaveLength(6);
    expect(DEVELOPMENT_CARDS).toEqual([
      "knight",
      "road-building",
      "year-of-plenty",
      "monopoly",
      "victory-point",
    ]);
  });
});
