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

const resourceSupplyViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
  const allResources = [state.bank, ...state.players.map(({ resources }) => resources)];
  const values = allResources.flatMap(resourceValues);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    violations.push("invalid-resource-count");
  }
  const hasInvalidSupply = RESOURCE_KEYS.some(
    (resource) => allResources.reduce((total, resources) => total + resources[resource], 0) !== 19,
  );
  if (hasInvalidSupply) violations.push("resource-conservation");
  return violations;
};

const pieceSupplyViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
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

const developmentCardViolations = (state: GameState): ReadonlyArray<string> => {
  const violations = state.players.flatMap((player) => {
    const playerViolations: string[] = [];
    if (
      player.developmentCards.some(
        ({ purchasedTurn }) => !Number.isSafeInteger(purchasedTurn) || purchasedTurn < 1,
      )
    ) {
      playerViolations.push(`development-card-turn:${player.id}`);
    }
    if (!Number.isSafeInteger(player.playedKnights) || player.playedKnights < 0) {
      playerViolations.push(`played-knights:${player.id}`);
    }
    return playerViolations;
  });
  const ownedCount = state.players.reduce(
    (total, player) => total + player.developmentCards.length,
    0,
  );
  const playedKnightCount = state.players.reduce(
    (total, player) => total + player.playedKnights,
    0,
  );
  const totalCount =
    state.developmentDeck.length + state.developmentDiscard.length + ownedCount + playedKnightCount;
  return totalCount === 25 ? violations : [...violations, "development-card-conservation"];
};

const supplyViolations = (state: GameState): ReadonlyArray<string> => [
  ...resourceSupplyViolations(state),
  ...pieceSupplyViolations(state),
  ...developmentCardViolations(state),
];

const validPlayerIndex = (state: GameState, playerIndex: number): boolean =>
  Number.isSafeInteger(playerIndex) && playerIndex >= 0 && playerIndex < state.players.length;

const discardPhaseViolations = (
  state: GameState,
  phase: Extract<GameState["phase"], { readonly tag: "turn.discard" }>,
): ReadonlyArray<string> => {
  const violations: string[] = [];
  if (!validPlayerIndex(state, phase.rollerIndex)) violations.push("discard-roller");
  const entries = [{ playerIndex: phase.playerIndex, remaining: phase.remaining }, ...phase.queue];
  if (entries.some(({ playerIndex }) => !validPlayerIndex(state, playerIndex))) {
    violations.push("discard-player");
  }
  if (entries.some(({ remaining }) => !Number.isSafeInteger(remaining) || remaining < 1)) {
    violations.push("discard-remaining");
  }
  if (duplicateValues(entries.map(({ playerIndex }) => String(playerIndex)))) {
    violations.push("duplicate-discard-player");
  }
  if (
    entries.some(({ playerIndex, remaining }) => {
      const player = state.players[playerIndex];
      return (
        player !== undefined &&
        resourceValues(player.resources).reduce((a, b) => a + b, 0) < remaining
      );
    })
  ) {
    violations.push("discard-exceeds-hand");
  }
  return violations;
};

const turnNumberViolations = (turn: number): ReadonlyArray<string> =>
  !Number.isSafeInteger(turn) || turn < 1 ? ["turn-number"] : [];

const freeRoadPhaseViolations = (
  phase: Extract<GameState["phase"], { readonly tag: "turn.free-road" }>,
): ReadonlyArray<string> =>
  !Number.isSafeInteger(phase.remaining) || phase.remaining < 1 || phase.remaining > 2
    ? ["free-road-remaining"]
    : [];

const turnPhaseViolations = (state: GameState): ReadonlyArray<string> => {
  const phase = state.phase;
  if (!("turn" in phase)) return [];
  const violations = [...turnNumberViolations(phase.turn)];
  if (phase.tag === "turn.discard") violations.push(...discardPhaseViolations(state, phase));
  if (phase.tag === "turn.free-road") violations.push(...freeRoadPhaseViolations(phase));
  return violations;
};

const phaseViolations = (state: GameState): ReadonlyArray<string> => {
  if (!validPlayerIndex(state, state.phase.playerIndex)) return ["active-player"];
  const violations = [...turnPhaseViolations(state)];
  if (state.phase.tag !== "setup.road") return violations;
  const player = state.players[state.phase.playerIndex];
  const settlementId = state.phase.settlementId;
  const anchor = state.occupancy.buildings.find(({ vertexId }) => vertexId === settlementId);
  return player === undefined || anchor?.playerId !== player.id
    ? [...violations, "road-anchor"]
    : violations;
};

export const checkInvariants = (state: GameState): ReadonlyArray<string> => [
  ...occupancyViolations(state),
  ...distanceViolations(state),
  ...supplyViolations(state),
  ...phaseViolations(state),
];
