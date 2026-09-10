import {
  createGame,
  handleCommand,
  legalActions,
  matchesCurrentGenerator,
  replay,
  STANDARD_TOPOLOGY,
  verifyNativeReplay,
} from "@catanarchy/engine";
import {
  decodeGameState,
  type GameConfig,
  type GameEvent,
  type GameState,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "portable-replay",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const createdEvent = (): GameEvent => Effect.runSync(createGame(config)).events[0];

const gameCreatedState = (event: GameEvent): GameState => {
  if (event.event.type !== "game.created") throw new Error("Expected game.created.");
  return event.event.state;
};

const stateWithDifferentValidShuffle = (state: GameState): GameState => {
  const terrain = [...state.layout.terrain];
  const leftIndex = terrain.findIndex(({ terrain: value }) => value !== "desert");
  const left = terrain[leftIndex];
  const rightIndex = terrain.findIndex(
    ({ terrain: value }, index) =>
      index > leftIndex && value !== "desert" && value !== left?.terrain,
  );
  const right = terrain[rightIndex];
  if (left === undefined || right === undefined) throw new Error("Expected two terrain kinds.");
  terrain[leftIndex] = { ...left, terrain: right.terrain };
  terrain[rightIndex] = { ...right, terrain: left.terrain };
  return { ...state, layout: { ...state.layout, terrain } };
};

describe("portable replay", () => {
  it("accepts the complete current generated starting state", () => {
    const first = createdEvent();
    const state = gameCreatedState(first);

    expect(Effect.runSync(decodeGameState(state))).toEqual(state);
    expect(Effect.runSync(replay([first]))).toEqual(state);
    expect(Effect.runSync(matchesCurrentGenerator(state))).toBe(true);
  });

  it("replays a valid stored starting state that differs from the current generator", () => {
    const first = createdEvent();
    const state = stateWithDifferentValidShuffle(gameCreatedState(first));
    const stored = { ...first, event: { type: "game.created" as const, state } };

    expect(Effect.runSync(replay([stored]))).toEqual(state);
    expect(Effect.runSync(matchesCurrentGenerator(state))).toBe(false);
  });

  it("rejects incomplete and invariant-breaking stored starting states", () => {
    const first = createdEvent();
    const state = gameCreatedState(first);
    const { bank: _bank, ...withoutBank } = state;
    expect(Either.isLeft(Effect.runSync(Effect.either(decodeGameState(withoutBank))))).toBe(true);

    const invalidState = {
      ...state,
      topology: { ...STANDARD_TOPOLOGY, coastalRing: STANDARD_TOPOLOGY.coastalRing.slice(1) },
    } as GameState;
    const invalidEvent = {
      ...first,
      event: { type: "game.created" as const, state: invalidState },
    };
    expect(Either.isLeft(Effect.runSync(Effect.either(replay([invalidEvent]))))).toBe(true);
  });

  it("keeps native command verification separate from stored-event reduction", () => {
    const created = Effect.runSync(createGame(config));
    let state = created.state;
    const events: GameEvent[] = [...created.events];
    while (state.phase.tag.startsWith("setup.")) {
      const action = legalActions(state)[0];
      if (action === undefined) throw new Error("Expected a legal setup action.");
      const accepted = Effect.runSync(handleCommand(state, action.command));
      state = accepted.state;
      events.push(...accepted.events);
    }
    const roll = legalActions(state)[0];
    if (roll === undefined) throw new Error("Expected a roll action.");
    const accepted = Effect.runSync(handleCommand(state, roll.command));
    const event = accepted.events[0];
    if (event?.event.type !== "dice.rolled") throw new Error("Expected a dice event.");
    const changed = {
      ...event,
      event: {
        ...event.event,
        nextRandom: { ...event.event.nextRandom, value: (event.event.nextRandom.value + 1) >>> 0 },
      },
    };
    const changedEvents = [...events, changed];

    expect(Effect.runSync(replay(changedEvents)).random.dice).toEqual(changed.event.nextRandom);
    expect(Either.isLeft(Effect.runSync(Effect.either(verifyNativeReplay(changedEvents))))).toBe(
      true,
    );
  });
});
