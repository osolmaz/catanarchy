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
  DevelopmentCard,
  GameCommand,
  GameConfig,
  GameEvent,
  GameState,
  PlayerId,
  Resource,
  ResourceCounts,
} from "@catanarchy/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };

const config = (seed = 42): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: `effects-${seed}`,
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

const amount = (resource: Resource, count: number): ResourceCounts => ({
  ...EMPTY,
  [resource]: count,
});

const baseState = (): GameState => {
  const state = Effect.runSync(createGame(config())).state;
  return {
    ...state,
    phase: {
      tag: "turn.action",
      playerIndex: 0,
      turn: 2,
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

const giveDevelopmentCard = (
  state: GameState,
  playerId: PlayerId,
  card: DevelopmentCard,
  purchasedTurn = 1,
): GameState => {
  const cardIndex = state.developmentDeck.indexOf(card);
  if (cardIndex < 0) throw new Error(`The deck does not contain ${card}.`);
  return {
    ...state,
    developmentDeck: state.developmentDeck.filter((_item, index) => index !== cardIndex),
    players: state.players.map((player) =>
      player.id === playerId
        ? {
            ...player,
            developmentCards: [...player.developmentCards, { card, purchasedTurn }],
          }
        : player,
    ),
  };
};

const command = (
  state: GameState,
  payload: GameCommand["command"],
  playerId: PlayerId = "red",
): GameCommand => ({
  schema: "catanarchy.command.v1",
  matchId: state.matchId,
  commandId: `test:${state.sequence + 1}:${payload.type}`,
  playerId,
  expectedSequence: state.sequence,
  command: payload,
});

const apply = (state: GameState, payload: GameCommand["command"], playerId: PlayerId = "red") =>
  Effect.runSync(handleCommand(state, command(state, payload, playerId)));

const diceStateForTotal = (total: number): GameState["random"]["dice"] => {
  for (let seed = 0; seed < 100_000; seed += 1) {
    const state = createRandomState(seed);
    const first = nextInt(state, 6);
    const second = nextInt(first.state, 6);
    if (first.value + second.value + 2 === total) return state;
  }
  throw new Error(`Could not find dice state for ${total}.`);
};

const withSeven = (state: GameState): GameState => ({
  ...state,
  phase: { tag: "turn.roll", playerIndex: 0, turn: 2, developmentCardPlayed: false },
  random: { ...state.random, dice: diceStateForTotal(7) },
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

const eventType = (result: ReturnType<typeof apply>): string => result.events[0]!.event.type;

const actionTypes = (state: GameState): ReadonlyArray<string> =>
  legalActions(state).map(({ command: actionCommand }) => actionCommand.command.type);

describe("seven and robber resolution", () => {
  it("discards half of each large hand in configured player order", () => {
    let state = transferToPlayer(baseState(), "red", amount("lumber", 8));
    state = transferToPlayer(state, "blue", amount("brick", 9));
    state = transferToPlayer(state, "white", amount("grain", 7));
    state = apply(withSeven(state), { type: "roll-dice" }).state;

    expect(state.phase).toMatchObject({
      tag: "turn.discard",
      playerIndex: 0,
      rollerIndex: 0,
      remaining: 4,
      queue: [{ playerIndex: 1, remaining: 4 }],
    });
    expect(actionTypes(state)).toEqual(["discard-resource"]);
    const discardActionIds = legalActions(state).map(({ id }) => id);
    expect(discardActionIds.every((id) => id.startsWith(`private-option:${state.sequence}:`))).toBe(
      true,
    );
    expect(discardActionIds.join(":")).not.toMatch(/lumber|brick|wool|grain|ore/);
    expect(checkInvariants(state)).toEqual([]);

    for (let index = 0; index < 4; index += 1) {
      state = apply(state, { type: "discard-resource", resource: "lumber" }).state;
    }
    expect(state.phase).toMatchObject({ tag: "turn.discard", playerIndex: 1, remaining: 4 });

    for (let index = 0; index < 4; index += 1) {
      state = apply(state, { type: "discard-resource", resource: "brick" }, "blue").state;
    }
    expect(state.phase).toMatchObject({ tag: "turn.robber", playerIndex: 0, source: "roll" });
    expect(state.players[0]!.resources.lumber).toBe(4);
    expect(state.players[1]!.resources.brick).toBe(5);
    expect(state.players[2]!.resources.grain).toBe(7);
    expect(checkInvariants(state)).toEqual([]);
  });

  it("moves the robber and steals one uniformly selected resource card", () => {
    const initial = baseState();
    const destination = initial.topology.hexes.find(({ id }) => id !== initial.layout.robberHexId)!;
    let state = transferToPlayer(initial, "blue", amount("brick", 2));
    state = {
      ...state,
      occupancy: {
        buildings: [{ vertexId: destination.vertexIds[0], playerId: "blue", kind: "settlement" }],
        roads: [],
      },
      phase: {
        tag: "turn.robber",
        playerIndex: 0,
        turn: 2,
        source: "roll",
        continuation: { tag: "turn.action", dice: [3, 4] },
        developmentCardPlayed: false,
      },
    };
    const beforeDraws = state.random.resourceSteal.draws;
    expect(() =>
      apply(state, { type: "move-robber", hexId: destination.id, victimPlayerId: null }),
    ).toThrow("eligible victim");
    expect(() =>
      apply(state, { type: "move-robber", hexId: destination.id, victimPlayerId: "white" }),
    ).toThrow("eligible victim");
    const result = apply(state, {
      type: "move-robber",
      hexId: destination.id,
      victimPlayerId: "blue",
    });
    const event = result.events[0]!.event;

    expect(event).toMatchObject({
      type: "robber.moved",
      fromHexId: state.layout.robberHexId,
      toHexId: destination.id,
      victimPlayerId: "blue",
      stolenResource: "brick",
    });
    expect(result.state.players[0]!.resources.brick).toBe(1);
    expect(result.state.players[1]!.resources.brick).toBe(1);
    expect(result.state.random.resourceSteal.draws).toBe(beforeDraws + 1);
    expect(result.state.phase).toMatchObject({ tag: "turn.action", dice: [3, 4] });
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("allows an empty eligible victim but does not advance theft randomness", () => {
    const initial = baseState();
    const destination = initial.topology.hexes.find(({ id }) => id !== initial.layout.robberHexId)!;
    const state: GameState = {
      ...initial,
      occupancy: {
        buildings: [{ vertexId: destination.vertexIds[0], playerId: "blue", kind: "settlement" }],
        roads: [],
      },
      phase: {
        tag: "turn.robber",
        playerIndex: 0,
        turn: 2,
        source: "roll",
        continuation: { tag: "turn.action", dice: [2, 5] },
        developmentCardPlayed: false,
      },
    };
    const result = apply(state, {
      type: "move-robber",
      hexId: destination.id,
      victimPlayerId: "blue",
    });

    expect(result.events[0]!.event).toMatchObject({ stolenResource: null });
    expect(result.state.random.resourceSteal).toEqual(state.random.resourceSteal);
  });

  it("rejects the current hex, unknown destinations, and invalid victims", () => {
    const initial = baseState();
    const destination = initial.topology.hexes.find(({ id }) => id !== initial.layout.robberHexId)!;
    const state: GameState = {
      ...initial,
      phase: {
        tag: "turn.robber",
        playerIndex: 0,
        turn: 2,
        source: "roll",
        continuation: { tag: "turn.action", dice: [3, 4] },
        developmentCardPlayed: false,
      },
    };

    expect(() =>
      apply(state, {
        type: "move-robber",
        hexId: state.layout.robberHexId,
        victimPlayerId: null,
      }),
    ).toThrow("different hex");
    expect(() =>
      apply(state, { type: "move-robber", hexId: "h:99:99", victimPlayerId: null }),
    ).toThrow("does not exist");
    expect(() =>
      apply(state, { type: "move-robber", hexId: destination.id, victimPlayerId: "blue" }),
    ).toThrow("eligible victim");
    expect(() =>
      apply(baseState(), { type: "move-robber", hexId: destination.id, victimPlayerId: null }),
    ).toThrow("No robber move");
  });
});

describe("development-card effects", () => {
  it("plays a Knight before rolling and resumes the pending roll", () => {
    let state = giveDevelopmentCard(baseState(), "red", "knight");
    state = {
      ...state,
      phase: { tag: "turn.roll", playerIndex: 0, turn: 2, developmentCardPlayed: false },
    };
    state = apply(state, { type: "play-knight" }).state;

    expect(state.phase).toMatchObject({
      tag: "turn.robber",
      source: "knight",
      continuation: { tag: "turn.roll" },
      developmentCardPlayed: true,
    });
    expect(state.players[0]!.playedKnights).toBe(1);
    expect(state.players[0]!.developmentCards).toEqual([]);

    const destination = state.topology.hexes.find(({ id }) => id !== state.layout.robberHexId)!;
    state = apply(state, {
      type: "move-robber",
      hexId: destination.id,
      victimPlayerId: null,
    }).state;
    expect(state.phase).toEqual({
      tag: "turn.roll",
      playerIndex: 0,
      turn: 2,
      developmentCardPlayed: true,
    });
    expect(actionTypes(state)).not.toContain("play-knight");
    expect(checkInvariants(state)).toEqual([]);
  });

  it("preserves nested robber moves when a Knight is played after a seven", () => {
    let state = giveDevelopmentCard(baseState(), "red", "knight");
    state = {
      ...state,
      phase: {
        tag: "turn.robber",
        playerIndex: 0,
        turn: 2,
        source: "roll",
        continuation: { tag: "turn.action", dice: [3, 4] },
        developmentCardPlayed: false,
      },
    };
    state = apply(state, { type: "play-knight" }).state;
    expect(state.phase).toMatchObject({
      tag: "turn.robber",
      source: "knight",
      continuation: { tag: "turn.robber", source: "roll" },
    });

    const first = state.topology.hexes.find(({ id }) => id !== state.layout.robberHexId)!;
    state = apply(state, { type: "move-robber", hexId: first.id, victimPlayerId: null }).state;
    expect(state.phase).toMatchObject({ tag: "turn.robber", source: "roll" });

    const second = state.topology.hexes.find(({ id }) => id !== state.layout.robberHexId)!;
    state = apply(state, { type: "move-robber", hexId: second.id, victimPlayerId: null }).state;
    expect(state.phase).toMatchObject({ tag: "turn.action", dice: [3, 4] });
  });

  it("enforces purchase-turn and one-action-card timing", () => {
    let state = giveDevelopmentCard(baseState(), "red", "knight", 2);
    state = giveDevelopmentCard(state, "red", "monopoly", 1);

    expect(actionTypes(state)).not.toContain("play-knight");
    expect(actionTypes(state)).toContain("play-monopoly");
    state = apply(state, { type: "play-monopoly", resource: "ore" }).state;
    expect(actionTypes(state)).not.toContain("play-knight");
    expect(actionTypes(state)).not.toContain("play-monopoly");
    expect(() => apply(state, { type: "play-knight" })).toThrow("cannot be played");
  });

  it("keeps instant card effects in the interrupted roll or robber phase", () => {
    let beforeRoll = giveDevelopmentCard(baseState(), "red", "monopoly");
    beforeRoll = {
      ...beforeRoll,
      phase: { tag: "turn.roll", playerIndex: 0, turn: 2, developmentCardPlayed: false },
    };
    beforeRoll = apply(beforeRoll, { type: "play-monopoly", resource: "grain" }).state;
    expect(beforeRoll.phase).toEqual({
      tag: "turn.roll",
      playerIndex: 0,
      turn: 2,
      developmentCardPlayed: true,
    });

    let beforeRobber = giveDevelopmentCard(baseState(), "red", "year-of-plenty");
    beforeRobber = {
      ...beforeRobber,
      phase: {
        tag: "turn.robber",
        playerIndex: 0,
        turn: 2,
        source: "roll",
        continuation: { tag: "turn.action", dice: [3, 4] },
        developmentCardPlayed: false,
      },
    };
    beforeRobber = apply(beforeRobber, {
      type: "play-year-of-plenty",
      resources: ["lumber", "brick"],
    }).state;
    expect(beforeRobber.phase).toMatchObject({ tag: "turn.robber", developmentCardPlayed: true });
    expect(beforeRobber.players[0]!.resources).toMatchObject({ lumber: 1, brick: 1 });
  });

  it("builds two connected roads without paying resources", () => {
    let state = giveDevelopmentCard(baseState(), "red", "road-building");
    const vertex = state.topology.vertices[0]!;
    state = {
      ...state,
      occupancy: {
        buildings: [{ vertexId: vertex.id, playerId: "red", kind: "settlement" }],
        roads: [],
      },
    };
    const bankBefore = state.bank;
    state = apply(state, { type: "play-road-building" }).state;
    expect(state.phase).toMatchObject({ tag: "turn.free-road", remaining: 2 });
    expect(checkInvariants(state)).toEqual([]);

    const first = legalActions(state)[0]!;
    state = Effect.runSync(handleCommand(state, first.command)).state;
    expect(state.phase).toMatchObject({ tag: "turn.free-road", remaining: 1 });
    const second = legalActions(state)[0]!;
    state = Effect.runSync(handleCommand(state, second.command)).state;

    expect(state.occupancy.roads).toHaveLength(2);
    expect(state.phase).toMatchObject({ tag: "turn.action", developmentCardPlayed: true });
    expect(state.bank).toEqual(bankBefore);
    expect(state.developmentDiscard).toContain("road-building");
    expect(checkInvariants(state)).toEqual([]);
  });

  it("limits Road Building to one placement when one road piece remains", () => {
    let state = giveDevelopmentCard(baseState(), "red", "road-building");
    state = {
      ...state,
      occupancy: {
        buildings: [
          {
            vertexId: state.topology.vertices[0]!.id,
            playerId: "red",
            kind: "settlement",
          },
        ],
        roads: state.topology.edges.slice(0, 14).map(({ id }) => ({ edgeId: id, playerId: "red" })),
      },
    };
    const played = apply(state, { type: "play-road-building" });

    expect(played.events[0]!.event).toMatchObject({
      type: "road-building.played",
      roadsToPlace: 1,
    });
    expect(played.state.phase).toMatchObject({ tag: "turn.free-road", remaining: 1 });
    expect(checkInvariants(played.state)).toEqual([]);
    const placement = legalActions(played.state)[0]!;
    const placed = Effect.runSync(handleCommand(played.state, placement.command));
    expect(placed.state.occupancy.roads).toHaveLength(15);
    expect(placed.state.phase).toMatchObject({ tag: "turn.action" });
  });

  it("consumes Road Building cleanly when no route is available", () => {
    const state = giveDevelopmentCard(baseState(), "red", "road-building");
    const result = apply(state, { type: "play-road-building" });

    expect(result.events[0]!.event).toMatchObject({
      type: "road-building.played",
      roadsToPlace: 0,
    });
    expect(result.state.phase).toMatchObject({ tag: "turn.action", developmentCardPlayed: true });
  });

  it("consumes Road Building cleanly when no road piece is available", () => {
    let state = giveDevelopmentCard(baseState(), "red", "road-building");
    state = {
      ...state,
      occupancy: {
        buildings: [],
        roads: state.topology.edges.slice(0, 15).map(({ id }) => ({ edgeId: id, playerId: "red" })),
      },
    };
    const result = apply(state, { type: "play-road-building" });

    expect(result.events[0]!.event).toMatchObject({
      type: "road-building.played",
      roadsToPlace: 0,
    });
    expect(result.state.phase).toMatchObject({ tag: "turn.action", developmentCardPlayed: true });
    expect(result.state.occupancy.roads).toHaveLength(15);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("rejects invalid free-road and discard commands", () => {
    const state = baseState();
    const edge = state.topology.edges[0]!;
    const freeRoad: GameState = {
      ...state,
      phase: {
        tag: "turn.free-road",
        playerIndex: 0,
        turn: 2,
        remaining: 2,
        continuation: { tag: "turn.action", dice: [3, 3] },
        developmentCardPlayed: true,
      },
    };

    expect(() => apply(state, { type: "place-free-road", edgeId: edge.id })).toThrow(
      "No free road",
    );
    expect(() =>
      apply(freeRoad, { type: "place-free-road", edgeId: "e:v:99:99|v:100:100" }),
    ).toThrow("does not exist");
    expect(() => apply(freeRoad, { type: "place-free-road", edgeId: edge.id })).toThrow("connect");

    const occupied: GameState = {
      ...freeRoad,
      occupancy: { buildings: [], roads: [{ edgeId: edge.id, playerId: "blue" }] },
    };
    expect(() => apply(occupied, { type: "place-free-road", edgeId: edge.id })).toThrow("occupied");

    const noPieces: GameState = {
      ...freeRoad,
      occupancy: {
        buildings: [],
        roads: state.topology.edges.slice(0, 15).map(({ id }) => ({ edgeId: id, playerId: "red" })),
      },
    };
    expect(legalActions(noPieces)).toEqual([]);
    expect(() =>
      apply(noPieces, { type: "place-free-road", edgeId: state.topology.edges[20]!.id }),
    ).toThrow("no road piece");

    const discard: GameState = {
      ...state,
      phase: {
        tag: "turn.discard",
        playerIndex: 0,
        rollerIndex: 0,
        turn: 2,
        dice: [3, 4],
        remaining: 1,
        queue: [],
        developmentCardPlayed: false,
      },
    };
    expect(() => apply(discard, { type: "discard-resource", resource: "ore" })).toThrow(
      "does not hold",
    );
    const knightDuringDiscard = giveDevelopmentCard(discard, "red", "knight");
    expect(() => apply(knightDuringDiscard, { type: "play-knight" })).toThrow("cannot be played");
    expect(() => apply(state, { type: "discard-resource", resource: "ore" })).toThrow(
      "No resource discard",
    );
  });

  it("takes only available cards for Year of Plenty", () => {
    let state = transferToPlayer(baseState(), "blue", amount("wool", 18));
    state = giveDevelopmentCard(state, "red", "year-of-plenty");
    const result = apply(state, {
      type: "play-year-of-plenty",
      resources: ["wool", "wool"],
    });

    expect(result.events[0]!.event).toMatchObject({
      type: "year-of-plenty.played",
      requested: ["wool", "wool"],
      granted: amount("wool", 1),
    });
    expect(result.state.players[0]!.resources.wool).toBe(1);
    expect(result.state.bank.wool).toBe(0);
    expect(result.state.developmentDiscard).toContain("year-of-plenty");
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("takes every named resource from all opponents for Monopoly", () => {
    let state = transferToPlayer(baseState(), "blue", amount("ore", 2));
    state = transferToPlayer(state, "white", amount("ore", 3));
    state = transferToPlayer(state, "orange", amount("ore", 1));
    state = giveDevelopmentCard(state, "red", "monopoly");
    const bankBefore = state.bank.ore;
    const result = apply(state, { type: "play-monopoly", resource: "ore" });

    expect(result.events[0]!.event).toMatchObject({
      type: "monopoly.played",
      resource: "ore",
      transfers: [
        { playerId: "blue", amount: 2 },
        { playerId: "white", amount: 3 },
        { playerId: "orange", amount: 1 },
      ],
    });
    expect(result.state.players.map(({ resources }) => resources.ore)).toEqual([6, 0, 0, 0]);
    expect(result.state.bank.ore).toBe(bankBefore);
    expect(result.state.developmentDiscard).toContain("monopoly");
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("shows development-card identities only to their owner", () => {
    const state = giveDevelopmentCard(baseState(), "red", "victory-point");

    expect(observe(state).ownDevelopmentCards).toBeNull();
    expect(observe(state, { type: "player", playerId: "blue" }).ownDevelopmentCards).toEqual([]);
    expect(observe(state, { type: "player", playerId: "red" }).ownDevelopmentCards).toEqual([
      { card: "victory-point", purchasedTurn: 1 },
    ]);
  });
});

describe("effect replay", () => {
  it("replays a naturally generated seven and robber move", () => {
    let replayed: GameState | undefined;
    let expected: GameState | undefined;
    for (let seed = 0; seed < 500 && replayed === undefined; seed += 1) {
      const created = Effect.runSync(createGame(config(seed)));
      const setup = completeSetup(created.state);
      const rolled = apply(setup.state, { type: "roll-dice" });
      if (rolled.state.phase.tag === "turn.robber") {
        const robber = legalActions(rolled.state)[0]!;
        const moved = Effect.runSync(handleCommand(rolled.state, robber.command));
        const events = [created.events[0]!, ...setup.events, ...rolled.events, ...moved.events];
        replayed = Effect.runSync(replay(events));
        expected = moved.state;
      }
    }
    expect(replayed).toEqual(expected);
    expect(replayed).toBeDefined();
  });

  it("uses stable event names for every new effect", () => {
    let state = giveDevelopmentCard(baseState(), "red", "year-of-plenty");
    expect(
      eventType(apply(state, { type: "play-year-of-plenty", resources: ["ore", "grain"] })),
    ).toBe("year-of-plenty.played");
    state = giveDevelopmentCard(baseState(), "red", "monopoly");
    expect(eventType(apply(state, { type: "play-monopoly", resource: "brick" }))).toBe(
      "monopoly.played",
    );
  });
});
