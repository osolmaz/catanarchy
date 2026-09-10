import {
  RESOURCE_TYPES,
  type DevelopmentCard,
  type GameState,
  type HarborKind,
  type ResourceCounts,
} from "@catanarchy/protocol";
import {
  resolveLargestArmy,
  resolveLongestRoad,
  totalVictoryPoints,
  victoryPointCardCount,
} from "./awards.js";
import { standardHarborEdgeIds } from "./layout.js";
import { STANDARD_TOPOLOGY } from "./topology.js";

const RESOURCE_KEYS = RESOURCE_TYPES;
const EXPECTED_TERRAIN = {
  forest: 4,
  hill: 3,
  pasture: 4,
  field: 4,
  mountain: 3,
  desert: 1,
} as const;
const EXPECTED_NUMBERS: Readonly<Record<number, number>> = {
  2: 1,
  3: 2,
  4: 2,
  5: 2,
  6: 2,
  8: 2,
  9: 2,
  10: 2,
  11: 2,
  12: 1,
};
const EXPECTED_HARBORS: Readonly<Record<HarborKind, number>> = {
  generic: 4,
  lumber: 1,
  brick: 1,
  wool: 1,
  grain: 1,
  ore: 1,
};
const EXPECTED_DEVELOPMENT_CARDS: Readonly<Record<DevelopmentCard, number>> = {
  knight: 14,
  "road-building": 2,
  "year-of-plenty": 2,
  monopoly: 2,
  "victory-point": 5,
};

const countValues = (values: ReadonlyArray<string | number>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const hasExpectedCounts = (
  values: ReadonlyArray<string | number>,
  expected: Readonly<Record<string, number>>,
): boolean => {
  const counts = countValues(values);
  return (
    values.length === Object.values(expected).reduce((total, count) => total + count, 0) &&
    Object.entries(expected).every(([value, count]) => counts.get(value) === count)
  );
};

const sameOrderedValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const validUnsignedInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;

const topologyViolations = (state: GameState): ReadonlyArray<string> =>
  sameOrderedValue(state.topology, STANDARD_TOPOLOGY) ? [] : ["standard-topology"];

const validConfigPlayers = (state: GameState): boolean =>
  state.config.players.length >= 3 &&
  state.config.players.length <= 4 &&
  !duplicateValues(state.config.players.map(({ id }) => id)) &&
  !duplicateValues(state.config.players.map(({ color }) => color));

const statePlayerOrderMatchesConfig = (state: GameState): boolean =>
  sameOrderedValue(
    state.players.map(({ id }) => id),
    state.config.players.map(({ id }) => id),
  );

const configViolations = (state: GameState): ReadonlyArray<string> => [
  ...(state.matchId === state.config.matchId ? [] : ["config-match"]),
  ...(Number.isSafeInteger(state.sequence) && state.sequence >= 0 ? [] : ["state-sequence"]),
  ...(validUnsignedInteger(state.config.seed) ? [] : ["config-seed"]),
  ...(validConfigPlayers(state) ? [] : ["config-players"]),
  ...(statePlayerOrderMatchesConfig(state) ? [] : ["state-player-order"]),
];

const validTerrainLayout = (state: GameState): boolean => {
  const terrain = new Map(state.layout.terrain.map((item) => [item.hexId, item.terrain]));
  const expectedHexIds = new Set(state.topology.hexes.map(({ id }) => id));
  return (
    terrain.size === state.layout.terrain.length &&
    terrain.size === expectedHexIds.size &&
    [...terrain.keys()].every((id) => expectedHexIds.has(id)) &&
    hasExpectedCounts(
      state.layout.terrain.map(({ terrain: value }) => value),
      EXPECTED_TERRAIN,
    )
  );
};

const validNumberLayout = (state: GameState): boolean => {
  const numbers = new Map(state.layout.numbers.map((item) => [item.hexId, item.number]));
  const expectedHexIds = new Set(state.topology.hexes.map(({ id }) => id));
  return (
    numbers.size === state.layout.numbers.length &&
    numbers.size === 18 &&
    [...numbers.keys()].every((id) => expectedHexIds.has(id)) &&
    hasExpectedCounts(
      state.layout.numbers.map(({ number }) => number),
      EXPECTED_NUMBERS,
    )
  );
};

const desertHexId = (state: GameState): string | undefined =>
  state.layout.terrain.find(({ terrain }) => terrain === "desert")?.hexId;

const validDesertLayout = (state: GameState): boolean => {
  const desert = desertHexId(state);
  return desert !== undefined && !state.layout.numbers.some(({ hexId }) => hexId === desert);
};

const validHarborLayout = (state: GameState): boolean => {
  const expectedHarbors = new Set(standardHarborEdgeIds(state.topology));
  const actualHarbors = new Set(state.layout.harbors.map(({ edgeId }) => edgeId));
  return (
    actualHarbors.size === state.layout.harbors.length &&
    actualHarbors.size === expectedHarbors.size &&
    [...actualHarbors].every((id) => expectedHarbors.has(id)) &&
    hasExpectedCounts(
      state.layout.harbors.map(({ kind }) => kind),
      EXPECTED_HARBORS,
    )
  );
};

const layoutViolations = (state: GameState): ReadonlyArray<string> => [
  ...(validTerrainLayout(state) ? [] : ["layout-terrain"]),
  ...(validNumberLayout(state) ? [] : ["layout-numbers"]),
  ...(validDesertLayout(state) ? [] : ["layout-desert"]),
  ...(validHarborLayout(state) ? [] : ["layout-harbors"]),
];

const randomViolations = (state: GameState): ReadonlyArray<string> =>
  Object.values(state.random).every(
    ({ algorithm, value, draws }) =>
      algorithm === "catanarchy-prng-v1" &&
      validUnsignedInteger(value) &&
      Number.isSafeInteger(draws) &&
      draws >= 0,
  )
    ? []
    : ["random-state"];

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
  const playerIds = new Set(state.players.map(({ id }) => id));
  if (state.occupancy.buildings.some(({ vertexId }) => !vertexIds.has(vertexId))) {
    violations.push("unknown-building");
  }
  if (state.occupancy.roads.some(({ edgeId }) => !edgeIds.has(edgeId))) {
    violations.push("unknown-road");
  }
  if (state.occupancy.buildings.some(({ playerId }) => !playerIds.has(playerId))) {
    violations.push("unknown-building-player");
  }
  if (state.occupancy.roads.some(({ playerId }) => !playerIds.has(playerId))) {
    violations.push("unknown-road-player");
  }
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
  const playedKnightCount = state.players.reduce(
    (total, player) => total + player.playedKnights,
    0,
  );
  const cards = [
    ...state.developmentDeck,
    ...state.developmentDiscard,
    ...state.players.flatMap(({ developmentCards }) => developmentCards.map(({ card }) => card)),
    ...Array.from({ length: playedKnightCount }, () => "knight" as const),
  ];
  if (!hasExpectedCounts(cards, EXPECTED_DEVELOPMENT_CARDS)) {
    violations.push("development-card-conservation");
  }
  return violations;
};

const supplyViolations = (state: GameState): ReadonlyArray<string> => [
  ...resourceSupplyViolations(state),
  ...pieceSupplyViolations(state),
  ...developmentCardViolations(state),
];

const awardViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
  const playerIds = new Set(state.players.map(({ id }) => id));
  if (
    state.awards.longestRoadPlayerId !== null &&
    !playerIds.has(state.awards.longestRoadPlayerId)
  ) {
    violations.push("longest-road-player");
  }
  if (
    state.awards.largestArmyPlayerId !== null &&
    !playerIds.has(state.awards.largestArmyPlayerId)
  ) {
    violations.push("largest-army-player");
  }
  if (resolveLongestRoad(state).playerId !== state.awards.longestRoadPlayerId) {
    violations.push("longest-road-holder");
  }
  if (resolveLargestArmy(state).playerId !== state.awards.largestArmyPlayerId) {
    violations.push("largest-army-holder");
  }
  return violations;
};

const winnerScoreViolations = (state: GameState): ReadonlyArray<string> => {
  if (state.result === null) return [];
  const violations: string[] = [];
  if (state.result.victoryPoints < 10) violations.push("winner-score");
  if (totalVictoryPoints(state, state.result.winnerId) !== state.result.victoryPoints) {
    violations.push("winner-score-mismatch");
  }
  if (
    victoryPointCardCount(state, state.result.winnerId) !== state.result.revealedVictoryPointCards
  ) {
    violations.push("winner-revealed-cards");
  }
  return violations;
};

const winnerPhaseViolations = (state: GameState, winnerIndex: number): ReadonlyArray<string> => {
  if (state.result === null) return [];
  return state.phase.tag !== "game.finished" ||
    state.phase.playerIndex !== winnerIndex ||
    state.phase.turn !== state.result.turn
    ? ["winner-phase"]
    : [];
};

const resultViolations = (state: GameState): ReadonlyArray<string> => {
  const violations: string[] = [];
  const finished = state.phase.tag === "game.finished";
  if ((state.result === null) === finished) violations.push("game-result-phase");
  if (state.result === null) return violations;
  const winnerIndex = state.config.players.findIndex(({ id }) => id === state.result?.winnerId);
  if (winnerIndex < 0) return [...violations, "winner-player"];
  return [
    ...violations,
    ...winnerScoreViolations(state),
    ...winnerPhaseViolations(state, winnerIndex),
  ];
};

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

export const checkInvariants = (state: GameState): ReadonlyArray<string> => {
  const topology = topologyViolations(state);
  if (topology.length > 0) return topology;
  const structure = [
    ...configViolations(state),
    ...layoutViolations(state),
    ...randomViolations(state),
  ];
  if (structure.length > 0) return structure;
  return [
    ...occupancyViolations(state),
    ...distanceViolations(state),
    ...supplyViolations(state),
    ...awardViolations(state),
    ...resultViolations(state),
    ...phaseViolations(state),
  ];
};

const emptyResources = (resources: ResourceCounts): boolean =>
  RESOURCE_KEYS.every((resource) => resources[resource] === 0);

const fullBank = (resources: ResourceCounts): boolean =>
  RESOURCE_KEYS.every((resource) => resources[resource] === 19);

const validInitialOccupancy = (state: GameState): boolean =>
  state.occupancy.buildings.length === 0 && state.occupancy.roads.length === 0;

const validInitialResources = (state: GameState): boolean =>
  fullBank(state.bank) && state.players.every(({ resources }) => emptyResources(resources));

const validInitialDevelopmentCards = (state: GameState): boolean =>
  state.developmentDiscard.length === 0 &&
  state.players.every(
    ({ developmentCards, playedKnights }) => developmentCards.length === 0 && playedKnights === 0,
  );

const validInitialResult = (state: GameState): boolean =>
  state.awards.longestRoadPlayerId === null &&
  state.awards.largestArmyPlayerId === null &&
  state.result === null;

const validInitialPhase = (state: GameState): boolean =>
  state.phase.tag === "setup.settlement" &&
  state.phase.direction === "forward" &&
  state.phase.playerIndex === 0;

const validInitialRobber = (state: GameState): boolean =>
  state.layout.robberHexId === desertHexId(state);

export const checkInitialStateInvariants = (state: GameState): ReadonlyArray<string> => [
  ...checkInvariants(state),
  ...(state.sequence === 0 ? [] : ["initial-sequence"]),
  ...(validInitialOccupancy(state) ? [] : ["initial-occupancy"]),
  ...(validInitialResources(state) ? [] : ["initial-resources"]),
  ...(validInitialDevelopmentCards(state) ? [] : ["initial-development-cards"]),
  ...(validInitialResult(state) ? [] : ["initial-result"]),
  ...(validInitialPhase(state) ? [] : ["initial-phase"]),
  ...(validInitialRobber(state) ? [] : ["initial-robber"]),
];
