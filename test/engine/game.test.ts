import {
  checkInvariants,
  createGame,
  handleCommand,
  legalActions,
  observe,
  replay,
} from "@catanarchy/engine";
import type { GameConfig, GameEvent, GameState, PlayerColor } from "@catanarchy/protocol";
import { Effect } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const COLORS: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];
const config = (count = 4, overrides: Partial<GameConfig> = {}): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: "test-match",
  seed: 42,
  players: COLORS.slice(0, count).map((color) => ({ id: color, name: color, color })),
  ...overrides,
});

const completeSetup = (
  initial: GameState,
): { readonly state: GameState; readonly events: ReadonlyArray<GameEvent> } => {
  let state = initial;
  const events: GameEvent[] = [];
  while (state.phase.tag !== "turn.roll") {
    const action = legalActions(state)[0];
    if (action === undefined) throw new Error("Expected a legal setup action.");
    const result = Effect.runSync(handleCommand(state, action.command));
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
};

const sum = (resources: GameState["bank"]): number =>
  resources.lumber + resources.brick + resources.wool + resources.grain + resources.ore;

const expectedLegalActionIds = (state: GameState): ReadonlyArray<string> => {
  if (state.phase.tag === "setup.settlement") {
    const occupied = new Set(state.occupancy.buildings.map(({ vertexId }) => vertexId));
    return state.topology.vertices
      .filter(
        (vertex) =>
          !occupied.has(vertex.id) &&
          vertex.adjacentVertexIds.every((neighborId) => !occupied.has(neighborId)),
      )
      .map(({ id }) => `settlement:${id}`);
  }
  if (state.phase.tag === "setup.road") {
    const occupied = new Set(state.occupancy.roads.map(({ edgeId }) => edgeId));
    const settlementId = state.phase.settlementId;
    return state.topology.edges
      .filter((edge) => edge.vertexIds.includes(settlementId) && !occupied.has(edge.id))
      .map(({ id }) => `road:${id}`);
  }
  return [];
};

describe("initial placement", () => {
  it.each([3, 4])("completes a %i-player setup", (playerCount) => {
    const created = Effect.runSync(createGame(config(playerCount)));
    const completed = completeSetup(created.state);

    expect(completed.state.phase).toEqual({ tag: "turn.roll", playerIndex: 0, turn: 1 });
    expect(completed.state.occupancy.buildings).toHaveLength(playerCount * 2);
    expect(completed.state.occupancy.roads).toHaveLength(playerCount * 2);
    for (const player of completed.state.players) {
      expect(
        completed.state.occupancy.buildings.filter(({ playerId }) => playerId === player.id),
      ).toHaveLength(2);
      expect(
        completed.state.occupancy.roads.filter(({ playerId }) => playerId === player.id),
      ).toHaveLength(2);
    }
  });

  it("uses forward and reverse player order", () => {
    const created = Effect.runSync(createGame(config()));
    const completed = completeSetup(created.state);
    const settlements = completed.events.filter((event) => event.type === "settlement.placed");
    const roads = completed.events.filter((event) => event.type === "road.placed");
    const expected = ["red", "blue", "white", "orange", "orange", "white", "blue", "red"];

    expect(settlements.map(({ playerId }) => playerId)).toEqual(expected);
    expect(roads.map(({ playerId }) => playerId)).toEqual(expected);
    expect(
      completed.events.filter((event) => event.type === "initial-resources.granted"),
    ).toHaveLength(4);
  });

  it("preserves resource cards when it grants starting resources", () => {
    const created = Effect.runSync(createGame(config()));
    const completed = completeSetup(created.state);
    const playerResources = completed.state.players.reduce(
      (total, player) => total + sum(player.resources),
      0,
    );

    expect(sum(completed.state.bank) + playerResources).toBe(95);
    expect(playerResources).toBeGreaterThan(0);
  });

  it("replays every accepted event to identical state", () => {
    const created = Effect.runSync(createGame(config()));
    const completed = completeSetup(created.state);
    const events = [...created.events, ...completed.events];

    expect(Effect.runSync(replay(events))).toEqual(completed.state);
  });

  it("resumes every accepted-command prefix to the same final setup", () => {
    const created = Effect.runSync(createGame(config()));
    let state = created.state;
    let events = [...created.events];
    const prefixes: GameEvent[][] = [events];
    while (state.phase.tag !== "turn.roll") {
      const action = legalActions(state)[0];
      if (action === undefined) throw new Error("Expected a legal setup action.");
      const result = Effect.runSync(handleCommand(state, action.command));
      state = result.state;
      events = [...events, ...result.events];
      prefixes.push(events);
    }
    const expectedState = state;
    const expectedEvents = events;

    for (const prefix of prefixes) {
      let resumedState = Effect.runSync(replay(prefix));
      const resumedEvents = [...prefix];
      while (resumedState.phase.tag !== "turn.roll") {
        const action = legalActions(resumedState)[0];
        if (action === undefined) throw new Error("Expected a legal resumed action.");
        const result = Effect.runSync(handleCommand(resumedState, action.command));
        resumedState = result.state;
        resumedEvents.push(...result.events);
      }
      expect(resumedState).toEqual(expectedState);
      expect(resumedEvents).toEqual(expectedEvents);
    }
  });

  it("offers only actions accepted by the engine", () => {
    const created = Effect.runSync(createGame(config()));
    for (const action of legalActions(created.state)) {
      expect(() => Effect.runSync(handleCommand(created.state, action.command))).not.toThrow();
    }
    expect(legalActions(created.state)).toHaveLength(54);
  });

  it("offers exactly the unoccupied roads beside the new settlement", () => {
    const created = Effect.runSync(createGame(config()));
    const settlement = legalActions(created.state)[0]!;
    const roadState = Effect.runSync(handleCommand(created.state, settlement.command)).state;
    if (roadState.phase.tag !== "setup.road") throw new Error("Expected a road phase.");
    const settlementId = roadState.phase.settlementId;
    const vertex = roadState.topology.vertices.find(({ id }) => id === settlementId)!;
    const actions = legalActions(roadState);

    expect(actions).toHaveLength(vertex.edgeIds.length);
    expect(
      actions.every(
        ({ command }) =>
          command.type === "place-initial-road" && vertex.edgeIds.includes(command.edgeId),
      ),
    ).toBe(true);
  });

  it("keeps every generated setup state valid", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.integer({ min: 3, max: 4 }),
        (seed, count) => {
          let state = Effect.runSync(createGame(config(count, { seed }))).state;
          expect(checkInvariants(state)).toEqual([]);
          while (state.phase.tag !== "turn.roll") {
            const actions = legalActions(state);
            expect(actions.map(({ id }) => id)).toEqual(expectedLegalActionIds(state));
            for (const action of actions) {
              expect(() => Effect.runSync(handleCommand(state, action.command))).not.toThrow();
            }
            const selected = actions[(seed + state.sequence) % actions.length];
            if (selected === undefined) throw new Error("Expected a generated setup action.");
            state = Effect.runSync(handleCommand(state, selected.command)).state;
            expect(checkInvariants(state)).toEqual([]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps private resource identities out of public observations", () => {
    const created = Effect.runSync(createGame(config()));
    const completed = completeSetup(created.state);
    const publicView = observe(completed.state);
    const redView = observe(completed.state, { type: "player", playerId: "red" });

    expect(publicView.ownResources).toBeNull();
    expect(redView.ownResources).toEqual(completed.state.players[0]?.resources);
    expect(JSON.stringify(publicView)).not.toContain('"developmentDeck"');
    expect(publicView.players.map(({ resourceCount }) => resourceCount)).toEqual(
      completed.state.players.map(({ resources }) => sum(resources)),
    );
  });
});
