import {
  decodeGameCommand,
  decodeGameConfig,
  decodeGameEventEnvelope,
  decodeNegotiationAction,
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

  it("decodes robber and development-card commands and events", () => {
    const move = {
      schema: "catanarchy.command.v1",
      matchId: "protocol",
      commandId: "robber-1",
      playerId: "red",
      expectedSequence: 21,
      command: { type: "move-robber", hexId: "h:0:0", victimPlayerId: null },
    };
    const plenty = {
      ...move,
      commandId: "plenty-1",
      command: { type: "play-year-of-plenty", resources: ["ore", "ore"] },
    };
    const robberEvent = {
      schema: "catanarchy.game-event.v1",
      matchId: "protocol",
      commandId: "robber-1",
      sequence: 22,
      event: {
        type: "robber.moved",
        playerId: "red",
        fromHexId: "h:0:0",
        toHexId: "h:1:0",
        victimPlayerId: null,
        stolenResource: null,
        nextRandom: { algorithm: "catanarchy-prng-v1", value: 7, draws: 0 },
      },
    };
    const monopolyEvent = {
      ...robberEvent,
      commandId: "monopoly-1",
      event: {
        type: "monopoly.played",
        playerId: "red",
        resource: "ore",
        transfers: [{ playerId: "blue", amount: 2 }],
      },
    };

    expect(Effect.runSync(decodeGameCommand(move))).toEqual(move);
    expect(Effect.runSync(decodeGameCommand(plenty))).toEqual(plenty);
    expect(Effect.runSync(decodeGameEventEnvelope(robberEvent))).toEqual(robberEvent);
    expect(Effect.runSync(decodeGameEventEnvelope(monopolyEvent))).toEqual(monopolyEvent);
  });

  it("decodes domestic trades and negotiation actions", () => {
    const resources = { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 };
    const command = {
      schema: "catanarchy.command.v1",
      matchId: "protocol",
      commandId: "domestic-1",
      playerId: "red",
      expectedSequence: 22,
      command: {
        type: "domestic-trade",
        partnerPlayerId: "blue",
        give: resources,
        receive: { ...resources, lumber: 0, brick: 1 },
      },
    };
    const event = {
      schema: "catanarchy.game-event.v1",
      matchId: "protocol",
      commandId: "domestic-1",
      sequence: 23,
      event: { ...command.command, type: "domestic-trade.completed", playerId: "red" },
    };
    const offer = {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      give: resources,
      receive: { ...resources, lumber: 0, brick: 1 },
    };

    expect(Effect.runSync(decodeGameCommand(command))).toEqual(command);
    expect(Effect.runSync(decodeGameEventEnvelope(event))).toEqual(event);
    expect(Effect.runSync(decodeNegotiationAction(offer))).toEqual(offer);
    expect(
      Either.isLeft(
        Effect.runSync(Effect.either(decodeNegotiationAction({ ...offer, type: "unknown" }))),
      ),
    ).toBe(true);
  });

  it("decodes award and victory events", () => {
    const longestRoad = {
      schema: "catanarchy.game-event.v1",
      matchId: "protocol",
      commandId: "road-5",
      sequence: 30,
      event: {
        type: "longest-road.changed",
        previousPlayerId: null,
        playerId: "red",
        length: 5,
      },
    };
    const largestArmy = {
      ...longestRoad,
      commandId: "knight-3",
      event: {
        type: "largest-army.changed",
        previousPlayerId: null,
        playerId: "red",
        size: 3,
      },
    };
    const won = {
      ...longestRoad,
      commandId: "win-1",
      sequence: 31,
      event: {
        type: "game.won",
        playerId: "red",
        playerIndex: 0,
        turn: 12,
        victoryPoints: 10,
        revealedVictoryPointCards: 2,
      },
    };

    expect(Effect.runSync(decodeGameEventEnvelope(longestRoad))).toEqual(longestRoad);
    expect(Effect.runSync(decodeGameEventEnvelope(largestArmy))).toEqual(largestArmy);
    expect(Effect.runSync(decodeGameEventEnvelope(won))).toEqual(won);
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
