import type { GameState, ResourceCounts } from "@catanarchy/protocol";

const RESOURCE_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;

const resourceValues = (resources: ResourceCounts): ReadonlyArray<number> =>
  RESOURCE_KEYS.map((resource) => resources[resource]);

const duplicateValues = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size !== values.length;

const occupancyViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
  if (duplicateValues(state.occupancy.buildings.map(({ vertexId }) => vertexId)))
    violations.push("duplicate-building");
  if (duplicateValues(state.occupancy.roads.map(({ edgeId }) => edgeId)))
    violations.push("duplicate-road");
  const vertexIds = new Set(state.topology.vertices.map(({ id }) => id));
  const edgeIds = new Set(state.topology.edges.map(({ id }) => id));
  if (state.occupancy.buildings.some(({ vertexId }) => !vertexIds.has(vertexId)))
    violations.push("unknown-building");
  if (state.occupancy.roads.some(({ edgeId }) => !edgeIds.has(edgeId)))
    violations.push("unknown-road");
  return violations;
};

const distanceViolations = (state: GameState): ReadonlyArray<string> => {
  const occupied = new Set(state.occupancy.buildings.map(({ vertexId }) => vertexId));
  const tooClose = state.occupancy.buildings.some((building) => {
    const vertex = state.topology.vertices.find(({ id }) => id === building.vertexId);
    return vertex?.adjacentVertexIds.some((id) => occupied.has(id)) ?? false;
  });
  return tooClose ? ["settlement-distance"] : [];
};

const supplyViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
  const allResources = [state.bank, ...state.players.map(({ resources }) => resources)];
  const values = allResources.flatMap(resourceValues);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    violations.push("invalid-resource-count");
  const hasInvalidSupply = RESOURCE_KEYS.some(
    (resource) => allResources.reduce((total, resources) => total + resources[resource], 0) !== 19,
  );
  if (hasInvalidSupply) violations.push("resource-conservation");
  for (const player of state.players) {
    const buildings = state.occupancy.buildings.filter(({ playerId }) => playerId === player.id);
    const settlements = buildings.filter(({ kind }) => kind === "settlement").length;
    const cities = buildings.filter(({ kind }) => kind === "city").length;
    if (settlements > 5 || cities > 4) violations.push(`building-supply:${player.id}`);
    if (state.occupancy.roads.filter(({ playerId }) => playerId === player.id).length > 15) {
      violations.push(`road-supply:${player.id}`);
    }
  }
  return violations;
};

const phaseViolations = (state: GameState): ReadonlyArray<string> => {
  if (state.phase.playerIndex < 0 || state.phase.playerIndex >= state.players.length)
    return ["active-player"];
  if (state.phase.tag !== "setup.road") return [];
  const player = state.players[state.phase.playerIndex];
  const settlementId = state.phase.settlementId;
  const anchor = state.occupancy.buildings.find(({ vertexId }) => vertexId === settlementId);
  return player === undefined || anchor?.playerId !== player.id ? ["road-anchor"] : [];
};

export const checkInvariants = (state: GameState): ReadonlyArray<string> => [
  ...occupancyViolations(state),
  ...distanceViolations(state),
  ...supplyViolations(state),
  ...phaseViolations(state),
];
