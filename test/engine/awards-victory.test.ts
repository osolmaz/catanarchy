import {
  checkInvariants,
  createGame,
  handleCommand,
  legalActions,
  longestRoadLength,
  observe,
  resolveLargestArmy,
  resolveLongestRoad,
  totalVictoryPoints,
  visibleVictoryPoints,
} from "@catanarchy/engine";
import type {
  DevelopmentCard,
  EdgeId,
  GameCommand,
  GameConfig,
  GameState,
  PlayerId,
  ResourceCounts,
  VertexId,
} from "@catanarchy/protocol";
import { Effect } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "awards-victory",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
};

const baseState = (): GameState => {
  const state = Effect.runSync(createGame(config)).state;
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

const edgeAt = (state: GameState, left: VertexId, right: VertexId): EdgeId => {
  const edge = state.topology.edges.find(
    ({ vertexIds }) => vertexIds.includes(left) && vertexIds.includes(right),
  );
  if (edge === undefined) throw new Error("Expected an edge between path vertices.");
  return edge.id;
};

const findPath = (
  state: GameState,
  length: number,
  excludedEdges: ReadonlySet<EdgeId> = new Set(),
): { readonly edges: ReadonlyArray<EdgeId>; readonly vertices: ReadonlyArray<VertexId> } => {
  const search = (
    vertexId: VertexId,
    edges: ReadonlyArray<EdgeId>,
    vertices: ReadonlyArray<VertexId>,
  ): {
    readonly edges: ReadonlyArray<EdgeId>;
    readonly vertices: ReadonlyArray<VertexId>;
  } | null => {
    if (edges.length === length) return { edges, vertices };
    const vertex = state.topology.vertices.find(({ id }) => id === vertexId)!;
    for (const nextVertexId of vertex.adjacentVertexIds) {
      const edgeId = edgeAt(state, vertexId, nextVertexId);
      if (excludedEdges.has(edgeId) || edges.includes(edgeId) || vertices.includes(nextVertexId)) {
        continue;
      }
      const found = search(nextVertexId, [...edges, edgeId], [...vertices, nextVertexId]);
      if (found !== null) return found;
    }
    return null;
  };

  for (const vertex of state.topology.vertices) {
    const found = search(vertex.id, [], [vertex.id]);
    if (found !== null) return found;
  }
  throw new Error(`Could not find a path of ${length} edges.`);
};

const roads = (playerId: PlayerId, edgeIds: ReadonlyArray<EdgeId>) =>
  edgeIds.map((edgeId) => ({ edgeId, playerId }));

const referenceLongestRoad = (state: GameState, playerId: PlayerId): number => {
  const playerEdges = state.occupancy.roads
    .filter((road) => road.playerId === playerId)
    .map((road) => state.topology.edges.find(({ id }) => id === road.edgeId)!)
    .filter((edge) => edge !== undefined);
  const blocked = new Set(
    state.occupancy.buildings
      .filter((building) => building.playerId !== playerId)
      .map(({ vertexId }) => vertexId),
  );
  const walk = (vertexId: VertexId, used: ReadonlySet<EdgeId>): number => {
    if (blocked.has(vertexId)) return 0;
    let longest = 0;
    for (const edge of playerEdges) {
      if (used.has(edge.id)) continue;
      const other =
        edge.vertexIds[0] === vertexId
          ? edge.vertexIds[1]
          : edge.vertexIds[1] === vertexId
            ? edge.vertexIds[0]
            : undefined;
      if (other === undefined) continue;
      longest = Math.max(longest, 1 + walk(other, new Set([...used, edge.id])));
    }
    return longest;
  };
  return playerEdges.reduce(
    (longest, edge) =>
      Math.max(
        longest,
        1 + walk(edge.vertexIds[0], new Set([edge.id])),
        1 + walk(edge.vertexIds[1], new Set([edge.id])),
      ),
    0,
  );
};

const independentVertices = (state: GameState, count: number): ReadonlyArray<VertexId> => {
  const selected: VertexId[] = [];
  for (const vertex of state.topology.vertices) {
    const blocked = selected.some((selectedId) => {
      const selectedVertex = state.topology.vertices.find(({ id }) => id === selectedId)!;
      return selectedId === vertex.id || selectedVertex.adjacentVertexIds.includes(vertex.id);
    });
    if (!blocked) selected.push(vertex.id);
    if (selected.length === count) return selected;
  }
  throw new Error(`Could not find ${count} independent vertices.`);
};

const moveCardsFromDeck = (
  state: GameState,
  playerId: PlayerId,
  card: DevelopmentCard,
  count: number,
  purchasedTurn: number,
): GameState => {
  let remaining = count;
  const developmentDeck = state.developmentDeck.filter((item) => {
    if (item !== card || remaining === 0) return true;
    remaining -= 1;
    return false;
  });
  if (remaining !== 0) throw new Error(`The deck does not contain ${count} ${card} cards.`);
  return {
    ...state,
    developmentDeck,
    players: state.players.map((player) =>
      player.id === playerId
        ? {
            ...player,
            developmentCards: [
              ...player.developmentCards,
              ...Array.from({ length: count }, () => ({ card, purchasedTurn })),
            ],
          }
        : player,
    ),
  };
};

const withPlayedKnights = (state: GameState, playerId: PlayerId, count: number): GameState => {
  let remaining = count;
  const developmentDeck = state.developmentDeck.filter((card) => {
    if (card !== "knight" || remaining === 0) return true;
    remaining -= 1;
    return false;
  });
  if (remaining !== 0) throw new Error(`The deck does not contain ${count} Knights.`);
  return {
    ...state,
    developmentDeck,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, playedKnights: count } : player,
    ),
  };
};

const withBuildings = (
  state: GameState,
  playerId: PlayerId,
  kinds: ReadonlyArray<"settlement" | "city">,
): GameState => {
  const vertices = independentVertices(state, kinds.length);
  return {
    ...state,
    occupancy: {
      ...state.occupancy,
      buildings: kinds.map((kind, index) => ({
        vertexId: vertices[index]!,
        playerId,
        kind,
      })),
    },
  };
};

const payPlayer = (state: GameState, playerId: PlayerId, resources: ResourceCounts): GameState => ({
  ...state,
  bank: {
    lumber: state.bank.lumber - resources.lumber,
    brick: state.bank.brick - resources.brick,
    wool: state.bank.wool - resources.wool,
    grain: state.bank.grain - resources.grain,
    ore: state.bank.ore - resources.ore,
  },
  players: state.players.map((player) =>
    player.id === playerId
      ? {
          ...player,
          resources: {
            lumber: player.resources.lumber + resources.lumber,
            brick: player.resources.brick + resources.brick,
            wool: player.resources.wool + resources.wool,
            grain: player.resources.grain + resources.grain,
            ore: player.resources.ore + resources.ore,
          },
        }
      : player,
  ),
});

describe("longest road search", () => {
  it("counts a simple path and does not sum all branches", () => {
    const state = baseState();
    const path = findPath(state, 5);
    const line: GameState = {
      ...state,
      occupancy: { buildings: [], roads: roads("red", path.edges) },
    };
    expect(longestRoadLength(line, "red")).toBe(5);

    const center = state.topology.vertices.find(
      ({ adjacentVertexIds }) => adjacentVertexIds.length === 3,
    )!;
    const starEdges = center.adjacentVertexIds.map((neighbor) =>
      edgeAt(state, center.id, neighbor),
    );
    const fork: GameState = {
      ...state,
      occupancy: { buildings: [], roads: roads("red", starEdges) },
    };
    expect(starEdges).toHaveLength(3);
    expect(longestRoadLength(fork, "red")).toBe(2);
  });

  it("counts cycles and a branch without reusing an edge", () => {
    const state = baseState();
    const hex = state.topology.hexes[0]!;
    const cycle: GameState = {
      ...state,
      occupancy: { buildings: [], roads: roads("red", hex.edgeIds) },
    };
    expect(longestRoadLength(cycle, "red")).toBe(6);

    const cycleEdges = new Set(hex.edgeIds);
    const branch = hex.vertexIds
      .flatMap((vertexId) =>
        state.topology.vertices
          .find(({ id }) => id === vertexId)!
          .edgeIds.filter((edgeId) => !cycleEdges.has(edgeId)),
      )
      .at(0)!;
    const branched: GameState = {
      ...state,
      occupancy: { buildings: [], roads: roads("red", [...hex.edgeIds, branch]) },
    };
    expect(longestRoadLength(branched, "red")).toBe(7);
  });

  it("matches an independent exhaustive search for generated road graphs", () => {
    const initial = baseState();
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: initial.topology.edges.length - 1 }), {
          maxLength: 15,
        }),
        fc.uniqueArray(fc.integer({ min: 0, max: initial.topology.vertices.length - 1 }), {
          maxLength: 3,
        }),
        (edgeIndexes, blockerIndexes) => {
          const edgeIds = edgeIndexes.map((index) => initial.topology.edges[index]!.id);
          const state: GameState = {
            ...initial,
            occupancy: {
              roads: roads("red", edgeIds),
              buildings: blockerIndexes.map((index) => ({
                vertexId: initial.topology.vertices[index]!.id,
                playerId: "blue",
                kind: "settlement",
              })),
            },
          };

          expect(longestRoadLength(state, "red")).toBe(referenceLongestRoad(state, "red"));
          expect(
            longestRoadLength(
              {
                ...state,
                occupancy: { ...state.occupancy, roads: state.occupancy.roads.toReversed() },
              },
              "red",
            ),
          ).toBe(referenceLongestRoad(state, "red"));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("stops a route at an opponent building", () => {
    const state = baseState();
    const path = findPath(state, 6);
    const uninterrupted: GameState = {
      ...state,
      occupancy: { buildings: [], roads: roads("red", path.edges) },
    };
    const interrupted: GameState = {
      ...uninterrupted,
      occupancy: {
        ...uninterrupted.occupancy,
        buildings: [{ vertexId: path.vertices[3]!, playerId: "blue", kind: "settlement" }],
      },
    };

    expect(longestRoadLength(uninterrupted, "red")).toBe(6);
    expect(longestRoadLength(interrupted, "red")).toBe(3);
  });
});

describe("award ownership", () => {
  it("retains a tied Longest Road and transfers only to a unique longer route", () => {
    const state = baseState();
    const red = findPath(state, 5);
    const blue = findPath(state, 5, new Set(red.edges));
    const tied: GameState = {
      ...state,
      awards: { ...state.awards, longestRoadPlayerId: "red" },
      occupancy: {
        buildings: [],
        roads: [...roads("red", red.edges), ...roads("blue", blue.edges)],
      },
    };

    expect(resolveLongestRoad(tied)).toEqual({ playerId: "red", value: 5 });
    expect(
      resolveLongestRoad({ ...tied, awards: { ...tied.awards, longestRoadPlayerId: null } }),
    ).toEqual({ playerId: null, value: 5 });

    const blueLonger = findPath(state, 6, new Set(red.edges));
    const transferred: GameState = {
      ...tied,
      occupancy: {
        buildings: [],
        roads: [...roads("red", red.edges), ...roads("blue", blueLonger.edges)],
      },
    };
    expect(resolveLongestRoad(transferred)).toEqual({ playerId: "blue", value: 6 });
  });

  it("leaves Longest Road vacant when an interruption removes the holder into a tie", () => {
    const state = baseState();
    const red = findPath(state, 6);
    const blue = findPath(state, 5, new Set(red.edges));
    const excluded = new Set([...red.edges, ...blue.edges]);
    const white = findPath(state, 5, excluded);
    const interrupted: GameState = {
      ...state,
      awards: { ...state.awards, longestRoadPlayerId: "red" },
      occupancy: {
        buildings: [{ vertexId: red.vertices[3]!, playerId: "orange", kind: "settlement" }],
        roads: [
          ...roads("red", red.edges),
          ...roads("blue", blue.edges),
          ...roads("white", white.edges),
        ],
      },
    };

    expect(longestRoadLength(interrupted, "red")).toBe(3);
    expect(resolveLongestRoad(interrupted)).toEqual({ playerId: null, value: 5 });
  });

  it("awards and transfers Largest Army with strict tie retention", () => {
    const state = baseState();
    const unowned: GameState = {
      ...state,
      players: state.players.map((player) =>
        player.id === "red" ? { ...player, playedKnights: 3 } : player,
      ),
    };
    expect(resolveLargestArmy(unowned)).toEqual({ playerId: "red", value: 3 });

    const tied: GameState = {
      ...unowned,
      awards: { ...state.awards, largestArmyPlayerId: "red" },
      players: unowned.players.map((player) =>
        player.id === "blue" ? { ...player, playedKnights: 3 } : player,
      ),
    };
    expect(resolveLargestArmy(tied)).toEqual({ playerId: "red", value: 3 });

    const surpassed: GameState = {
      ...tied,
      players: tied.players.map((player) =>
        player.id === "blue" ? { ...player, playedKnights: 4 } : player,
      ),
    };
    expect(resolveLargestArmy(surpassed)).toEqual({ playerId: "blue", value: 4 });
  });

  it("records Longest Road immediately after the fifth road", () => {
    const initial = baseState();
    const path = findPath(initial, 5);
    let state: GameState = {
      ...initial,
      occupancy: { buildings: [], roads: roads("red", path.edges.slice(0, 4)) },
    };
    state = payPlayer(state, "red", { ...EMPTY, lumber: 1, brick: 1 });
    const result = apply(state, { type: "build-road", edgeId: path.edges[4]! });

    expect(result.events.map(({ event }) => event.type)).toEqual([
      "road.built",
      "longest-road.changed",
    ]);
    expect(result.state.awards.longestRoadPlayerId).toBe("red");
    expect(visibleVictoryPoints(result.state, "red")).toBe(2);
    expect(checkInvariants(result.state)).toEqual([]);
  });
});

describe("victory", () => {
  it("counts hidden points only for the authorized seat", () => {
    let state = withBuildings(baseState(), "red", ["settlement"]);
    state = moveCardsFromDeck(state, "red", "victory-point", 2, 1);

    expect(visibleVictoryPoints(state, "red")).toBe(1);
    expect(totalVictoryPoints(state, "red")).toBe(3);
    expect(observe(state).players[0]!.visibleVictoryPoints).toBe(1);
    expect(observe(state).ownVictoryPoints).toBeNull();
    expect(observe(state, { type: "player", playerId: "red" }).ownVictoryPoints).toBe(3);
    expect(observe(state, { type: "player", playerId: "blue" }).ownVictoryPoints).toBe(0);
  });

  it("wins after buying a same-turn Victory Point card", () => {
    let state = withBuildings(baseState(), "red", ["city", "city", "city", "city", "settlement"]);
    state = payPlayer(state, "red", { ...EMPTY, wool: 1, grain: 1, ore: 1 });
    const victoryIndex = state.developmentDeck.indexOf("victory-point");
    state = {
      ...state,
      developmentDeck: [
        "victory-point",
        ...state.developmentDeck.filter((_card, index) => index !== victoryIndex),
      ],
    };
    const result = apply(state, { type: "buy-development-card" });

    expect(result.events.map(({ event }) => event.type)).toEqual([
      "development-card.bought",
      "game.won",
    ]);
    expect(result.state.result).toEqual({
      winnerId: "red",
      turn: 2,
      victoryPoints: 10,
      revealedVictoryPointCards: 1,
    });
    expect(result.state.phase).toEqual({ tag: "game.finished", playerIndex: 0, turn: 2 });
    expect(legalActions(result.state)).toEqual([]);
    expect(observe(result.state).activePlayerId).toBeNull();
    expect(observe(result.state).players[0]!.visibleVictoryPoints).toBe(10);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("orders Largest Army before a victory caused by the third Knight", () => {
    let state = withBuildings(baseState(), "red", ["city", "city", "city", "city"]);
    state = withPlayedKnights(state, "red", 2);
    state = moveCardsFromDeck(state, "red", "knight", 1, 1);
    const result = apply(state, { type: "play-knight" });

    expect(result.events.map(({ event }) => event.type)).toEqual([
      "knight.played",
      "largest-army.changed",
      "game.won",
    ]);
    expect(result.state.awards.largestArmyPlayerId).toBe("red");
    expect(result.state.result?.victoryPoints).toBe(10);
    expect(result.state.players[0]!.playedKnights).toBe(3);
    expect(checkInvariants(result.state)).toEqual([]);
  });

  it("does not let a discarding opponent win during the roller's turn", () => {
    let state = withBuildings(baseState(), "blue", ["city", "city", "city", "city"]);
    state = moveCardsFromDeck(state, "blue", "victory-point", 2, 1);
    state = payPlayer(state, "blue", { ...EMPTY, lumber: 8 });
    state = {
      ...state,
      phase: {
        tag: "turn.discard",
        playerIndex: 1,
        rollerIndex: 0,
        turn: 2,
        dice: [3, 4],
        remaining: 4,
        queue: [],
        developmentCardPlayed: false,
      },
    };
    const result = apply(state, { type: "discard-resource", resource: "lumber" }, "blue");

    expect(totalVictoryPoints(result.state, "blue")).toBe(10);
    expect(result.state.result).toBeNull();
    expect(result.state.phase.tag).toBe("turn.discard");
  });

  it("waits until a player's own turn to recognize an existing winning score", () => {
    let state = withBuildings(baseState(), "blue", ["city", "city", "city", "city"]);
    state = moveCardsFromDeck(state, "blue", "victory-point", 2, 1);

    expect(totalVictoryPoints(state, "blue")).toBe(10);
    expect(state.result).toBeNull();
    const result = apply(state, { type: "end-turn" });

    expect(result.events.map(({ event }) => event.type)).toEqual(["turn.ended", "game.won"]);
    expect(result.state.result).toEqual({
      winnerId: "blue",
      turn: 3,
      victoryPoints: 10,
      revealedVictoryPointCards: 2,
    });
    expect(result.state.phase).toEqual({ tag: "game.finished", playerIndex: 1, turn: 3 });
    expect(checkInvariants(result.state)).toEqual([]);
  });
});
