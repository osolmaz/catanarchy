import {
  checkInvariants,
  createGame,
  createRandomState,
  handleCommand,
  legalActions,
  nextInt,
  observe,
  replay,
} from "@catanarchy/engine";
import type {
  EdgeId,
  GameCommand,
  GameConfig,
  GameEvent,
  GameState,
  PlayerId,
  Resource,
  ResourceCounts,
  VertexId,
} from "@catanarchy/protocol";
import { Effect } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const RESOURCES = ["lumber", "brick", "wool", "grain", "ore"] as const;
const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const TERRAIN_RESOURCE = {
  forest: "lumber",
  hill: "brick",
  pasture: "wool",
  field: "grain",
  mountain: "ore",
} as const;

const config = (seed = 42): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: `normal-${seed}`,
  seed,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
});

const add = (left: ResourceCounts, right: ResourceCounts): ResourceCounts => ({
  lumber: left.lumber + right.lumber,
  brick: left.brick + right.brick,
  wool: left.wool + right.wool,
  grain: left.grain + right.grain,
  ore: left.ore + right.ore,
});

const subtract = (left: ResourceCounts, right: ResourceCounts): ResourceCounts => ({
  lumber: left.lumber - right.lumber,
  brick: left.brick - right.brick,
  wool: left.wool - right.wool,
  grain: left.grain - right.grain,
  ore: left.ore - right.ore,
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

const blankState = (): GameState => {
  const state = Effect.runSync(createGame(config())).state;
  return {
    ...state,
    phase: {
      tag: "turn.action",
      playerIndex: 0,
      turn: 1,
      dice: [3, 3],
      developmentCardPlayed: false,
    },
  };
};

const transferToPlayer = (
  state: GameState,
  playerId: PlayerId,
  resources: ResourceCounts,
): GameState => ({
  ...state,
  bank: subtract(state.bank, resources),
  players: state.players.map((player) =>
    player.id === playerId ? { ...player, resources: add(player.resources, resources) } : player,
  ),
});

const amount = (resource: Resource, count: number): ResourceCounts => ({
  ...EMPTY,
  [resource]: count,
});

const command = (
  state: GameState,
  payload: GameCommand["command"],
  playerId = "red",
): GameCommand => ({
  schema: "catanarchy.command.v1",
  matchId: state.matchId,
  commandId: `test:${state.sequence + 1}:${payload.type}`,
  playerId,
  expectedSequence: state.sequence,
  command: payload,
});

const diceStateForTotal = (total: number): GameState["random"]["dice"] => {
  for (let seed = 0; seed < 100_000; seed += 1) {
    const state = createRandomState(seed);
    const first = nextInt(state, 6);
    const second = nextInt(first.state, 6);
    if (first.value + second.value + 2 === total) return state;
  }
  throw new Error(`Could not find dice state for ${total}.`);
};

const withRollTotal = (state: GameState, total: number): GameState => ({
  ...state,
  phase: { tag: "turn.roll", playerIndex: 0, turn: 1, developmentCardPlayed: false },
  random: { ...state.random, dice: diceStateForTotal(total) },
});

const roll = (state: GameState) =>
  Effect.runSync(handleCommand(state, command(state, { type: "roll-dice" })));

const resourceForHex = (state: GameState, hexId: string): Resource => {
  const terrain = state.layout.terrain.find((placement) => placement.hexId === hexId)?.terrain;
  if (terrain === undefined || terrain === "desert") throw new Error("Expected a productive hex.");
  return TERRAIN_RESOURCE[terrain];
};

const roadFixture = (): {
  readonly state: GameState;
  readonly edgeId: EdgeId;
  readonly start: VertexId;
  readonly end: VertexId;
} => {
  const state = transferToPlayer(blankState(), "red", {
    lumber: 5,
    brick: 5,
    wool: 5,
    grain: 5,
    ore: 4,
  });
  const edge = state.topology.edges[0]!;
  return {
    state: {
      ...state,
      occupancy: {
        buildings: [{ vertexId: edge.vertexIds[0], playerId: "red", kind: "settlement" }],
        roads: [],
      },
    },
    edgeId: edge.id,
    start: edge.vertexIds[0],
    end: edge.vertexIds[1],
  };
};

describe("normal turn production", () => {
  it("draws two deterministic dice and records the next random state", () => {
    const state = withRollTotal(blankState(), 6);
    const first = roll(state);
    const second = roll(state);
    const event = first.events[0]!.event;

    expect(first).toEqual(second);
    expect(event.type).toBe("dice.rolled");
    if (event.type !== "dice.rolled") throw new Error("Expected dice event.");
    expect(event.dice[0] + event.dice[1]).toBe(6);
    expect(event.nextRandom.draws).toBe(state.random.dice.draws + 2);
    expect(first.state.phase.tag).toBe("turn.action");
  });

  it("pays settlements once and cities twice", () => {
    const initial = blankState();
    const token = initial.layout.numbers[0]!;
    const hex = initial.topology.hexes.find(({ id }) => id === token.hexId)!;
    const resource = resourceForHex(initial, token.hexId);
    const state = withRollTotal(
      {
        ...initial,
        occupancy: {
          buildings: [
            { vertexId: hex.vertexIds[0], playerId: "red", kind: "settlement" },
            { vertexId: hex.vertexIds[2], playerId: "blue", kind: "city" },
          ],
          roads: [],
        },
      },
      token.number,
    );

    const result = roll(state);
    expect(result.state.players[0]!.resources[resource]).toBe(1);
    expect(result.state.players[1]!.resources[resource]).toBe(2);
    expect(result.state.bank[resource]).toBe(16);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("blocks production on the robber hex", () => {
    const initial = blankState();
    const token = initial.layout.numbers[0]!;
    const hex = initial.topology.hexes.find(({ id }) => id === token.hexId)!;
    const state = withRollTotal(
      {
        ...initial,
        layout: { ...initial.layout, robberHexId: token.hexId },
        occupancy: {
          buildings: [{ vertexId: hex.vertexIds[0], playerId: "red", kind: "city" }],
          roads: [],
        },
      },
      token.number,
    );

    const result = roll(state);
    const event = result.events[0]!.event;
    expect(event.type === "dice.rolled" ? event.grants : null).toEqual([]);
    expect(result.state.bank).toEqual(state.bank);
  });

  it("gives the remaining cards when a shortage affects one player", () => {
    const initial = blankState();
    const token = initial.layout.numbers[0]!;
    const hex = initial.topology.hexes.find(({ id }) => id === token.hexId)!;
    const resource = resourceForHex(initial, token.hexId);
    const stocked = transferToPlayer(initial, "blue", amount(resource, 18));
    const state = withRollTotal(
      {
        ...stocked,
        occupancy: {
          buildings: [{ vertexId: hex.vertexIds[0], playerId: "red", kind: "city" }],
          roads: [],
        },
      },
      token.number,
    );

    const result = roll(state);
    const event = result.events[0]!.event;
    expect(result.state.players[0]!.resources[resource]).toBe(1);
    expect(result.state.bank[resource]).toBe(0);
    expect(event.type === "dice.rolled" ? event.shortages : []).toContain(resource);
  });

  it("gives nobody that resource when a shortage affects multiple players", () => {
    const initial = blankState();
    const token = initial.layout.numbers[0]!;
    const hex = initial.topology.hexes.find(({ id }) => id === token.hexId)!;
    const resource = resourceForHex(initial, token.hexId);
    const stocked = transferToPlayer(initial, "orange", amount(resource, 18));
    const state = withRollTotal(
      {
        ...stocked,
        occupancy: {
          buildings: [
            { vertexId: hex.vertexIds[0], playerId: "red", kind: "settlement" },
            { vertexId: hex.vertexIds[2], playerId: "blue", kind: "settlement" },
          ],
          roads: [],
        },
      },
      token.number,
    );

    const result = roll(state);
    const event = result.events[0]!.event;
    expect(result.state.players[0]!.resources[resource]).toBe(0);
    expect(result.state.players[1]!.resources[resource]).toBe(0);
    expect(result.state.bank[resource]).toBe(1);
    expect(event.type === "dice.rolled" ? event.shortages : []).toContain(resource);
  });

  it("requires a robber move after a seven when no discard is needed", () => {
    const state = withRollTotal(blankState(), 7);
    const result = roll(state);

    expect(result.state.phase.tag).toBe("turn.robber");
    expect(legalActions(result.state)).toHaveLength(18);
    expect(
      legalActions(result.state).every(({ command }) => command.command.type === "move-robber"),
    ).toBe(true);
  });
});

describe("normal turn actions", () => {
  it("builds a connected road and pays one lumber and one brick", () => {
    const fixture = roadFixture();
    const before = fixture.state.players[0]!.resources;
    const result = Effect.runSync(
      handleCommand(
        fixture.state,
        command(fixture.state, { type: "build-road", edgeId: fixture.edgeId }),
      ),
    );

    expect(result.state.occupancy.roads).toContainEqual({
      edgeId: fixture.edgeId,
      playerId: "red",
    });
    expect(result.state.players[0]!.resources).toEqual({
      ...before,
      lumber: before.lumber - 1,
      brick: before.brick - 1,
    });
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("does not connect a road through an opponent building", () => {
    const fixture = roadFixture();
    const startVertex = fixture.state.topology.vertices.find(({ id }) => id === fixture.start)!;
    const nextEdgeId = startVertex.edgeIds.find((id) => id !== fixture.edgeId)!;
    const state: GameState = {
      ...fixture.state,
      occupancy: {
        buildings: [{ vertexId: fixture.start, playerId: "blue", kind: "settlement" }],
        roads: [{ edgeId: fixture.edgeId, playerId: "red" }],
      },
    };

    expect(legalActions(state).map(({ id }) => id)).not.toContain(`build-road:${nextEdgeId}`);
    expect(() =>
      Effect.runSync(
        handleCommand(state, command(state, { type: "build-road", edgeId: nextEdgeId })),
      ),
    ).toThrow("connect");
  });

  it("builds a route-connected settlement that satisfies the distance rule", () => {
    const fixture = roadFixture();
    const middle = fixture.state.topology.vertices.find(({ id }) => id === fixture.end)!;
    const secondEdgeId = middle.edgeIds.find((id) => id !== fixture.edgeId)!;
    const secondEdge = fixture.state.topology.edges.find(({ id }) => id === secondEdgeId)!;
    const target = secondEdge.vertexIds.find((id) => id !== fixture.end)!;
    const state: GameState = {
      ...fixture.state,
      occupancy: {
        buildings: [{ vertexId: fixture.start, playerId: "red", kind: "settlement" }],
        roads: [
          { edgeId: fixture.edgeId, playerId: "red" },
          { edgeId: secondEdgeId, playerId: "red" },
        ],
      },
    };

    const result = Effect.runSync(
      handleCommand(state, command(state, { type: "build-settlement", vertexId: target })),
    );
    expect(result.state.occupancy.buildings).toContainEqual({
      vertexId: target,
      playerId: "red",
      kind: "settlement",
    });
    expect(result.state.players[0]!.resources).toEqual({
      lumber: 4,
      brick: 4,
      wool: 4,
      grain: 4,
      ore: 4,
    });
  });

  it("rejects unknown and occupied paid settlement locations", () => {
    const fixture = roadFixture();
    expect(() =>
      Effect.runSync(
        handleCommand(
          fixture.state,
          command(fixture.state, { type: "build-settlement", vertexId: "v:99:99" }),
        ),
      ),
    ).toThrow("does not exist");
    expect(() =>
      Effect.runSync(
        handleCommand(
          fixture.state,
          command(fixture.state, { type: "build-settlement", vertexId: fixture.start }),
        ),
      ),
    ).toThrow("occupied");
  });

  it("replaces an owned settlement with a city and pays its cost", () => {
    const fixture = roadFixture();
    const otherVertex = fixture.state.topology.vertices.find(({ id }) => id !== fixture.start)!;
    const state: GameState = {
      ...fixture.state,
      occupancy: {
        ...fixture.state.occupancy,
        buildings: [
          ...fixture.state.occupancy.buildings,
          { vertexId: otherVertex.id, playerId: "blue", kind: "settlement" },
        ],
      },
    };
    const result = Effect.runSync(
      handleCommand(state, command(state, { type: "build-city", vertexId: fixture.start })),
    );

    expect(result.state.occupancy.buildings).toContainEqual({
      vertexId: fixture.start,
      playerId: "red",
      kind: "city",
    });
    expect(result.state.players[0]!.resources.grain).toBe(3);
    expect(result.state.players[0]!.resources.ore).toBe(1);
    expect(result.state.occupancy.buildings).toContainEqual({
      vertexId: otherVertex.id,
      playerId: "blue",
      kind: "settlement",
    });
    expect(result.state.occupancy.buildings).toHaveLength(2);
  });

  it("buys the top development card without exposing its identity in observations", () => {
    const state = roadFixture().state;
    const topCard = state.developmentDeck[0]!;
    const result = Effect.runSync(
      handleCommand(state, command(state, { type: "buy-development-card" })),
    );
    const player = result.state.players[0]!;

    expect(player.developmentCards).toEqual([{ card: topCard, purchasedTurn: 1 }]);
    expect(result.state.developmentDeck).toHaveLength(24);
    expect(result.state.players[0]!.resources).toEqual({
      lumber: 5,
      brick: 5,
      wool: 4,
      grain: 4,
      ore: 3,
    });
    expect(JSON.stringify(result.state)).toContain(topCard);
    expect(JSON.stringify(observe(result.state))).not.toContain(topCard);
    expect(JSON.stringify(observe(result.state, { type: "player", playerId: "red" }))).toContain(
      topCard,
    );
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("rejects purchases when the development deck is empty", () => {
    const fixture = roadFixture();
    const ownedCards = fixture.state.developmentDeck.map((card) => ({ card, purchasedTurn: 1 }));
    const state: GameState = {
      ...fixture.state,
      developmentDeck: [],
      players: fixture.state.players.map((player) =>
        player.id === "blue" ? { ...player, developmentCards: ownedCards } : player,
      ),
    };

    expect(legalActions(state).map(({ id }) => id)).not.toContain("buy-development-card");
    expect(() =>
      Effect.runSync(handleCommand(state, command(state, { type: "buy-development-card" }))),
    ).toThrow("development deck is empty");
  });

  it.each([
    { harbor: "none" as const, expectedRate: 4 },
    { harbor: "generic" as const, expectedRate: 3 },
    { harbor: "specific" as const, expectedRate: 2 },
  ])("uses the $expectedRate:1 maritime rate", ({ harbor, expectedRate }) => {
    let state = blankState();
    let give: Resource = "lumber";
    let buildingVertex: VertexId | undefined;
    if (harbor !== "none") {
      const placement = state.layout.harbors.find(({ kind }) =>
        harbor === "generic" ? kind === "generic" : kind !== "generic",
      )!;
      const edge = state.topology.edges.find(({ id }) => id === placement.edgeId)!;
      buildingVertex = edge.vertexIds[0];
      if (placement.kind !== "generic") give = placement.kind;
    }
    state = transferToPlayer(state, "red", amount(give, expectedRate));
    if (buildingVertex !== undefined) {
      state = {
        ...state,
        occupancy: {
          buildings: [{ vertexId: buildingVertex, playerId: "red", kind: "settlement" }],
          roads: [],
        },
      };
    }
    const receive = RESOURCES.find((resource) => resource !== give)!;
    const result = Effect.runSync(
      handleCommand(state, command(state, { type: "maritime-trade", give, receive })),
    );
    const event = result.events[0]!.event;

    expect(event.type === "maritime-trade.completed" ? event.rate : null).toBe(expectedRate);
    expect(result.state.players[0]!.resources[give]).toBe(0);
    expect(result.state.players[0]!.resources[receive]).toBe(1);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("rejects like-for-like maritime trade", () => {
    const state = transferToPlayer(blankState(), "red", amount("lumber", 4));
    expect(legalActions(state).map(({ id }) => id)).not.toContain("maritime:lumber:lumber");
    expect(() =>
      Effect.runSync(
        handleCommand(
          state,
          command(state, { type: "maritime-trade", give: "lumber", receive: "lumber" }),
        ),
      ),
    ).toThrow("cannot be completed");
  });

  it("advances the player and absolute turn counter", () => {
    const state = blankState();
    const result = Effect.runSync(handleCommand(state, command(state, { type: "end-turn" })));

    expect(result.state.phase).toEqual({
      tag: "turn.roll",
      playerIndex: 1,
      turn: 2,
      developmentCardPlayed: false,
    });
    expect(legalActions(result.state)).toHaveLength(1);
    expect(legalActions(result.state)[0]!.command.playerId).toBe("blue");
  });

  it("enforces costs, piece supplies, phase, and stale command checks", () => {
    const fixture = roadFixture();
    const poorState: GameState = {
      ...fixture.state,
      bank: add(fixture.state.bank, fixture.state.players[0]!.resources),
      players: fixture.state.players.map((player) =>
        player.id === "red" ? { ...player, resources: EMPTY } : player,
      ),
    };
    expect(() =>
      Effect.runSync(
        handleCommand(
          poorState,
          command(poorState, { type: "build-road", edgeId: fixture.edgeId }),
        ),
      ),
    ).toThrow("cannot pay");

    const roadLimited: GameState = {
      ...fixture.state,
      occupancy: {
        ...fixture.state.occupancy,
        roads: Array.from({ length: 15 }, (_, index) => ({
          edgeId: fixture.state.topology.edges[index]!.id,
          playerId: "red",
        })),
      },
    };
    expect(() =>
      Effect.runSync(
        handleCommand(
          roadLimited,
          command(roadLimited, {
            type: "build-road",
            edgeId: fixture.state.topology.edges[20]!.id,
          }),
        ),
      ),
    ).toThrow("no road piece");

    const rollPhase: GameState = {
      ...fixture.state,
      phase: { tag: "turn.roll", playerIndex: 0, turn: 1, developmentCardPlayed: false },
    };
    expect(() =>
      Effect.runSync(handleCommand(rollPhase, command(rollPhase, { type: "end-turn" }))),
    ).toThrow("only available");

    const stale = command(fixture.state, { type: "end-turn" });
    expect(() => Effect.runSync(handleCommand({ ...fixture.state, sequence: 1 }, stale))).toThrow(
      "current event sequence",
    );
  });
});

describe("normal turn replay and legal actions", () => {
  it("replays dice and turn events to the same state", () => {
    let seed = 0;
    let replayCase:
      | { readonly events: ReadonlyArray<GameEvent>; readonly state: GameState }
      | undefined;
    while (replayCase === undefined) {
      const created = Effect.runSync(createGame(config(seed)));
      const setup = completeSetup(created.state);
      const rolled = Effect.runSync(
        handleCommand(setup.state, legalActions(setup.state)[0]!.command),
      );
      if (rolled.state.phase.tag === "turn.action") {
        const ended = Effect.runSync(
          handleCommand(
            rolled.state,
            legalActions(rolled.state).find(({ id }) => id === "end-turn")!.command,
          ),
        );
        replayCase = {
          events: [...created.events, ...setup.events, ...rolled.events, ...ended.events],
          state: ended.state,
        };
      }
      seed += 1;
    }

    expect(Effect.runSync(replay(replayCase.events))).toEqual(replayCase.state);
  });

  it("offers only accepted actions through generated normal-turn prefixes", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (seed) => {
        const created = Effect.runSync(createGame(config(seed)));
        let state = completeSetup(created.state).state;
        for (let step = 0; step < 12; step += 1) {
          const actions = legalActions(state);
          for (const action of actions) {
            expect(() => Effect.runSync(handleCommand(state, action.command))).not.toThrow();
          }
          expect(checkInvariants(state)).toEqual([]);
          if (actions.length === 0) break;
          const selected =
            actions.find(({ id }) => id === "end-turn") ?? actions[(seed + step) % actions.length]!;
          state = Effect.runSync(handleCommand(state, selected.command)).state;
        }
      }),
      { numRuns: 50 },
    );
  });
});
