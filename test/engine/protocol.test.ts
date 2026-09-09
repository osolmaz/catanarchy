import {
  decodeGameConfig,
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

  it("exports stable vocabulary", () => {
    expect(PLAYER_COLORS).toEqual(["red", "blue", "white", "orange"]);
    expect(RESOURCE_TYPES).toHaveLength(5);
    expect(TERRAIN_TYPES).toHaveLength(6);
  });
});
