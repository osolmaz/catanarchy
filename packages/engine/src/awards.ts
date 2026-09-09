import type { GameState, PlayerId, VertexId } from "@catanarchy/protocol";

interface RoadArc {
  readonly index: number;
  readonly otherVertexId: VertexId;
}

export interface AwardResolution {
  readonly playerId: PlayerId | null;
  readonly value: number;
}

const playerRoadGraph = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyMap<VertexId, ReadonlyArray<RoadArc>> => {
  const graph = new Map<VertexId, RoadArc[]>();
  const roads = state.occupancy.roads.filter((road) => road.playerId === playerId);
  for (const [index, road] of roads.entries()) {
    const edge = state.topology.edges.find(({ id }) => id === road.edgeId);
    if (edge === undefined) continue;
    const [left, right] = edge.vertexIds;
    graph.set(left, [...(graph.get(left) ?? []), { index, otherVertexId: right }]);
    graph.set(right, [...(graph.get(right) ?? []), { index, otherVertexId: left }]);
  }
  return graph;
};

const blockedVertices = (state: GameState, playerId: PlayerId): ReadonlySet<VertexId> =>
  new Set(
    state.occupancy.buildings
      .filter((building) => building.playerId !== playerId)
      .map(({ vertexId }) => vertexId),
  );

export const longestRoadLength = (state: GameState, playerId: PlayerId): number => {
  const graph = playerRoadGraph(state, playerId);
  const blocked = blockedVertices(state, playerId);
  const memo = new Map<string, number>();

  const walk = (vertexId: VertexId, usedRoads: number): number => {
    if (blocked.has(vertexId)) return 0;
    const key = `${vertexId}:${usedRoads}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let longest = 0;
    for (const arc of graph.get(vertexId) ?? []) {
      const bit = 1 << arc.index;
      if ((usedRoads & bit) !== 0) continue;
      longest = Math.max(longest, 1 + walk(arc.otherVertexId, usedRoads | bit));
    }
    memo.set(key, longest);
    return longest;
  };

  let longest = 0;
  for (const arcs of graph.values()) {
    for (const arc of arcs) {
      longest = Math.max(longest, 1 + walk(arc.otherVertexId, 1 << arc.index));
    }
  }
  return longest;
};

const resolveAward = (
  values: ReadonlyArray<{ readonly playerId: PlayerId; readonly value: number }>,
  currentPlayerId: PlayerId | null,
  minimum: number,
): AwardResolution => {
  const greatest = Math.max(0, ...values.map(({ value }) => value));
  if (greatest < minimum) return { playerId: null, value: greatest };
  const leaders = values.filter(({ value }) => value === greatest);
  if (currentPlayerId !== null && leaders.some(({ playerId }) => playerId === currentPlayerId)) {
    return { playerId: currentPlayerId, value: greatest };
  }
  return { playerId: leaders.length === 1 ? leaders[0]!.playerId : null, value: greatest };
};

export const resolveLongestRoad = (state: GameState): AwardResolution =>
  resolveAward(
    state.players.map(({ id }) => ({ playerId: id, value: longestRoadLength(state, id) })),
    state.awards.longestRoadPlayerId,
    5,
  );

export const resolveLargestArmy = (state: GameState): AwardResolution =>
  resolveAward(
    state.players.map(({ id, playedKnights }) => ({ playerId: id, value: playedKnights })),
    state.awards.largestArmyPlayerId,
    3,
  );

const buildingVictoryPoints = (state: GameState, playerId: PlayerId): number =>
  state.occupancy.buildings
    .filter((building) => building.playerId === playerId)
    .reduce((total, building) => total + (building.kind === "city" ? 2 : 1), 0);

export const victoryPointCardCount = (state: GameState, playerId: PlayerId): number =>
  state.players
    .find(({ id }) => id === playerId)
    ?.developmentCards.filter(({ card }) => card === "victory-point").length ?? 0;

const awardVictoryPoints = (state: GameState, playerId: PlayerId): number =>
  (state.awards.longestRoadPlayerId === playerId ? 2 : 0) +
  (state.awards.largestArmyPlayerId === playerId ? 2 : 0);

export const visibleVictoryPoints = (state: GameState, playerId: PlayerId): number => {
  const revealed = state.result?.winnerId === playerId ? state.result.revealedVictoryPointCards : 0;
  return buildingVictoryPoints(state, playerId) + awardVictoryPoints(state, playerId) + revealed;
};

export const totalVictoryPoints = (state: GameState, playerId: PlayerId): number =>
  buildingVictoryPoints(state, playerId) +
  awardVictoryPoints(state, playerId) +
  victoryPointCardCount(state, playerId);
