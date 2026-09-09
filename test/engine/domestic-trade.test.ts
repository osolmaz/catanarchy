import {
  checkInvariants,
  createGame,
  handleCommand,
  legalActions,
  replay,
} from "@catanarchy/engine";
import type {
  DomesticTradeCommand,
  GameCommand,
  GameConfig,
  GameEvent,
  GameState,
  PlayerColor,
  ResourceCounts,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const COLORS: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];
const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "domestic-trade",
  seed: 42,
  players: COLORS.map((color) => ({ id: color, name: color, color })),
};

const completeSetup = (): {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
} => {
  const created = Effect.runSync(createGame(config));
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  while (state.phase.tag !== "turn.roll") {
    const action = legalActions(state)[0];
    if (action === undefined) throw new Error("Expected a setup action.");
    const result = Effect.runSync(handleCommand(state, action.command));
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
};

const withHands = (
  state: GameState,
  hands: Readonly<Record<string, ResourceCounts>>,
): GameState => {
  const players = state.players.map((player) => ({
    ...player,
    resources: hands[player.id] ?? EMPTY,
  }));
  return {
    ...state,
    players,
    bank: {
      lumber: 19 - players.reduce((sum, player) => sum + player.resources.lumber, 0),
      brick: 19 - players.reduce((sum, player) => sum + player.resources.brick, 0),
      wool: 19 - players.reduce((sum, player) => sum + player.resources.wool, 0),
      grain: 19 - players.reduce((sum, player) => sum + player.resources.grain, 0),
      ore: 19 - players.reduce((sum, player) => sum + player.resources.ore, 0),
    },
    phase: {
      tag: "turn.action",
      playerIndex: 0,
      turn: 1,
      dice: [3, 4],
      developmentCardPlayed: false,
    },
  };
};

const tradeCommand = (
  state: GameState,
  overrides: Partial<DomesticTradeCommand> = {},
): GameCommand => ({
  schema: "catanarchy.command.v1",
  matchId: state.matchId,
  commandId: `trade:${state.sequence + 1}`,
  playerId: "red",
  expectedSequence: state.sequence,
  command: {
    type: "domestic-trade",
    partnerPlayerId: "blue",
    give: { ...EMPTY, lumber: 1 },
    receive: { ...EMPTY, brick: 1 },
    ...overrides,
  },
});

const readyState = (): GameState =>
  withHands(completeSetup().state, {
    red: { ...EMPTY, lumber: 2 },
    blue: { ...EMPTY, brick: 2 },
  });

const errorCode = (state: GameState, command: GameCommand): string => {
  const result = Effect.runSync(Effect.either(handleCommand(state, command)));
  if (Either.isRight(result)) throw new Error("Expected a rejected command.");
  return result.left.code;
};

describe("domestic trade", () => {
  it("settles both resource bundles atomically and preserves supply", () => {
    const state = readyState();
    const result = Effect.runSync(handleCommand(state, tradeCommand(state)));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event).toEqual({
      type: "domestic-trade.completed",
      playerId: "red",
      partnerPlayerId: "blue",
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, brick: 1 },
    });
    expect(result.state.players.find(({ id }) => id === "red")?.resources).toEqual({
      ...EMPTY,
      lumber: 1,
      brick: 1,
    });
    expect(result.state.players.find(({ id }) => id === "blue")?.resources).toEqual({
      ...EMPTY,
      lumber: 1,
      brick: 1,
    });
    expect(result.state.bank).toEqual(state.bank);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("preserves every resource supply for generated bundle sizes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 19 }),
        fc.integer({ min: 1, max: 19 }),
        (lumber, brick) => {
          const state = withHands(completeSetup().state, {
            red: { ...EMPTY, lumber },
            blue: { ...EMPTY, brick },
          });
          const result = Effect.runSync(
            handleCommand(
              state,
              tradeCommand(state, {
                give: { ...EMPTY, lumber },
                receive: { ...EMPTY, brick },
              }),
            ),
          );
          expect(checkInvariants(result.state)).toEqual([]);
          expect(result.state.bank).toEqual(state.bank);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("replays an accepted trade exactly", () => {
    const setup = completeSetup();
    let state = setup.state;
    const events = [...setup.events];
    while (state.phase.tag !== "turn.action") {
      const action = legalActions(state)[0];
      if (action === undefined) throw new Error("Expected an action before domestic trade.");
      const result = Effect.runSync(handleCommand(state, action.command));
      state = result.state;
      events.push(...result.events);
    }
    const active = state.players[0]!;
    const resourceKeys = Object.keys(active.resources) as Array<keyof ResourceCounts>;
    const give = resourceKeys.find((resource) => active.resources[resource] > 0);
    const candidate = state.players
      .slice(1)
      .flatMap((partner) =>
        resourceKeys
          .filter((resource) => resource !== give && partner.resources[resource] > 0)
          .map((receive) => ({ partner, receive })),
      )[0];
    if (give === undefined || candidate === undefined) {
      throw new Error("The replay fixture needs one naturally legal domestic trade.");
    }
    const command = tradeCommand(state, {
      partnerPlayerId: candidate.partner.id,
      give: { ...EMPTY, [give]: 1 },
      receive: { ...EMPTY, [candidate.receive]: 1 },
    });
    const traded = Effect.runSync(handleCommand(state, command));
    const replayed = Effect.runSync(replay([...events, ...traded.events]));

    expect(replayed).toEqual(traded.state);
  });

  it.each([
    ["gift from the active player", { give: EMPTY }],
    ["gift from the partner", { receive: EMPTY }],
    ["negative count", { give: { ...EMPTY, lumber: -1 } }],
    ["fractional count", { give: { ...EMPTY, lumber: 0.5 } }],
    ["overlapping resource", { give: { ...EMPTY, lumber: 1 }, receive: { ...EMPTY, lumber: 1 } }],
  ])("rejects an invalid bundle: %s", (_label, override) => {
    const state = readyState();
    expect(errorCode(state, tradeCommand(state, override))).toBe("invalid-trade");
  });

  it("rejects self-trades and unknown partners", () => {
    const state = readyState();
    expect(errorCode(state, tradeCommand(state, { partnerPlayerId: "red" }))).toBe("invalid-trade");
    expect(errorCode(state, tradeCommand(state, { partnerPlayerId: "missing" }))).toBe(
      "invalid-trade",
    );
  });

  it("rejects settlement when either hand changed", () => {
    const state = readyState();
    expect(errorCode(state, tradeCommand(state, { give: { ...EMPTY, lumber: 3 } }))).toBe(
      "insufficient-resources",
    );
    expect(errorCode(state, tradeCommand(state, { receive: { ...EMPTY, brick: 3 } }))).toBe(
      "insufficient-resources",
    );
  });

  it("rejects wrong-phase and stale settlement commands", () => {
    const actionState = readyState();
    const rollState: GameState = {
      ...actionState,
      phase: { tag: "turn.roll", playerIndex: 0, turn: 1, developmentCardPlayed: false },
    };
    expect(errorCode(rollState, tradeCommand(rollState))).toBe("wrong-command");
    expect(
      errorCode(actionState, {
        ...tradeCommand(actionState),
        expectedSequence: actionState.sequence - 1,
      }),
    ).toBe("stale-command");
  });

  it("does not enumerate an unagreed parameterized trade", () => {
    const state = readyState();
    expect(
      legalActions(state).some(({ command }) => command.command.type === "domestic-trade"),
    ).toBe(false);
  });
});
