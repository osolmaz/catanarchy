import type {
  CommandResult,
  GameCommand,
  GameConfig,
  GameCreatedEvent,
  GameEvent,
  GameObservation,
  GameState,
  InitialPlacementCompletedEvent,
  InitialResourcesGrantedEvent,
  LegalAction,
  PlaceInitialRoadCommand,
  PlaceInitialSettlementCommand,
  PlayerId,
  PlayerState,
  Resource,
  ResourceCounts,
  RoadPlacedEvent,
  SettlementPlacedEvent,
  SetupPhase,
  Terrain,
  Viewer,
} from "@catanarchy/protocol";
import { decodeGameConfig } from "@catanarchy/protocol";
import { Effect } from "effect";
import { ReplayViolation, RuleViolation } from "./errors.js";
import { generateGameMaterials } from "./layout.js";
import { STANDARD_TOPOLOGY } from "./topology.js";

const EMPTY_RESOURCES: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const FULL_BANK: ResourceCounts = { lumber: 19, brick: 19, wool: 19, grain: 19, ore: 19 };
const TERRAIN_RESOURCE: Readonly<Partial<Record<Terrain, Resource>>> = {
  forest: "lumber",
  hill: "brick",
  pasture: "wool",
  field: "grain",
  mountain: "ore",
};

const failure = (
  code: RuleViolation["code"],
  message: string,
): Effect.Effect<never, RuleViolation> => Effect.fail(new RuleViolation({ code, message }));

const hasDuplicates = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size !== values.length;

const validateConfig = (config: GameConfig): Effect.Effect<void, RuleViolation> => {
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) {
    return failure("invalid-seed", "The seed must be an unsigned 32-bit integer.");
  }
  if (config.players.length < 3 || config.players.length > 4) {
    return failure("invalid-player-count", "A base game needs three or four players.");
  }
  if (hasDuplicates(config.players.map(({ id }) => id))) {
    return failure("duplicate-player-id", "Each player must have a unique ID.");
  }
  if (hasDuplicates(config.players.map(({ color }) => color))) {
    return failure("duplicate-player-color", "Each player must have a unique color.");
  }
  return Effect.void;
};

const createPlayers = (config: GameConfig): ReadonlyArray<PlayerState> =>
  config.players.map(({ id }) => ({
    id,
    resources: EMPTY_RESOURCES,
    developmentCards: [],
    playedKnights: 0,
  }));

export const createGame = (input: GameConfig): Effect.Effect<CommandResult, RuleViolation> =>
  Effect.gen(function* () {
    const config = yield* decodeGameConfig(input).pipe(
      Effect.mapError(
        () =>
          new RuleViolation({
            code: "invalid-config",
            message: "The configuration must match catanarchy.game-config.v1.",
          }),
      ),
    );
    yield* validateConfig(config);
    const materials = generateGameMaterials(STANDARD_TOPOLOGY, config.seed);
    const state: GameState = {
      schema: "catanarchy.game-state.v1",
      matchId: config.matchId,
      sequence: 0,
      config,
      topology: STANDARD_TOPOLOGY,
      layout: materials.layout,
      occupancy: { buildings: [], roads: [] },
      bank: FULL_BANK,
      players: createPlayers(config),
      developmentDeck: materials.developmentDeck,
      phase: { tag: "setup.settlement", direction: "forward", playerIndex: 0 },
      random: {
        board: materials.boardRandom,
        developmentDeck: materials.developmentDeckRandom,
      },
    };
    const event: GameCreatedEvent = {
      sequence: 0,
      type: "game.created",
      commandId: `create:${config.matchId}`,
      state,
    };
    return { state, events: [event] };
  });

const addResources = (left: ResourceCounts, right: ResourceCounts): ResourceCounts => ({
  lumber: left.lumber + right.lumber,
  brick: left.brick + right.brick,
  wool: left.wool + right.wool,
  grain: left.grain + right.grain,
  ore: left.ore + right.ore,
});

const subtractResources = (left: ResourceCounts, right: ResourceCounts): ResourceCounts => ({
  lumber: left.lumber - right.lumber,
  brick: left.brick - right.brick,
  wool: left.wool - right.wool,
  grain: left.grain - right.grain,
  ore: left.ore - right.ore,
});

const updatePlayerResources = (
  players: ReadonlyArray<PlayerState>,
  playerId: PlayerId,
  resources: ResourceCounts,
): ReadonlyArray<PlayerState> =>
  players.map((player) =>
    player.id === playerId
      ? { ...player, resources: addResources(player.resources, resources) }
      : player,
  );

const nextPhaseAfterRoad = (state: GameState): SetupPhase => {
  if (state.phase.tag !== "setup.road") {
    return state.phase;
  }
  const { direction, playerIndex } = state.phase;
  if (direction === "forward") {
    return playerIndex === state.players.length - 1
      ? { tag: "setup.settlement", direction: "reverse", playerIndex }
      : { tag: "setup.settlement", direction, playerIndex: playerIndex + 1 };
  }
  return playerIndex === 0
    ? { tag: "setup.completing", playerIndex: 0 }
    : { tag: "setup.settlement", direction, playerIndex: playerIndex - 1 };
};

const applySettlement = (state: GameState, event: SettlementPlacedEvent): GameState => {
  if (state.phase.tag !== "setup.settlement") {
    return state;
  }
  return {
    ...state,
    sequence: event.sequence,
    occupancy: {
      ...state.occupancy,
      buildings: [
        ...state.occupancy.buildings,
        { vertexId: event.vertexId, playerId: event.playerId, kind: "settlement" },
      ],
    },
    phase: {
      tag: "setup.road",
      direction: state.phase.direction,
      playerIndex: state.phase.playerIndex,
      settlementId: event.vertexId,
    },
  };
};

const applyInitialResources = (
  state: GameState,
  event: InitialResourcesGrantedEvent,
): GameState => ({
  ...state,
  sequence: event.sequence,
  bank: subtractResources(state.bank, event.resources),
  players: updatePlayerResources(state.players, event.playerId, event.resources),
});

const applyRoad = (state: GameState, event: RoadPlacedEvent): GameState => ({
  ...state,
  sequence: event.sequence,
  occupancy: {
    ...state.occupancy,
    roads: [...state.occupancy.roads, { edgeId: event.edgeId, playerId: event.playerId }],
  },
  phase: nextPhaseAfterRoad(state),
});

const applyCompleted = (state: GameState, event: InitialPlacementCompletedEvent): GameState => ({
  ...state,
  sequence: event.sequence,
  phase: { tag: "turn.roll", playerIndex: 0, turn: 1 },
});

export const applyEvent = (
  state: GameState,
  event: Exclude<GameEvent, GameCreatedEvent>,
): GameState => {
  switch (event.type) {
    case "settlement.placed":
      return applySettlement(state, event);
    case "initial-resources.granted":
      return applyInitialResources(state, event);
    case "road.placed":
      return applyRoad(state, event);
    case "initial-placement.completed":
      return applyCompleted(state, event);
  }
};

const currentPlayerId = (state: GameState): PlayerId | null => {
  const player = state.config.players[state.phase.playerIndex];
  return player?.id ?? null;
};

const checkCommonCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<void, RuleViolation> => {
  if (command.expectedSequence !== state.sequence) {
    return failure("stale-command", "The command does not use the current event sequence.");
  }
  if (currentPlayerId(state) !== command.playerId) {
    return failure("wrong-player", "Only the active player can place a piece.");
  }
  return Effect.void;
};

const isSettlementLocationLegal = (state: GameState, vertexId: string): boolean => {
  const vertex = state.topology.vertices.find(({ id }) => id === vertexId);
  if (
    vertex === undefined ||
    state.occupancy.buildings.some((building) => building.vertexId === vertexId)
  ) {
    return false;
  }
  return !vertex.adjacentVertexIds.some((id) =>
    state.occupancy.buildings.some((building) => building.vertexId === id),
  );
};

const startingResources = (state: GameState, vertexId: string): ResourceCounts => {
  const vertex = state.topology.vertices.find(({ id }) => id === vertexId);
  const terrainByHex = new Map(state.layout.terrain.map(({ hexId, terrain }) => [hexId, terrain]));
  const resources = { ...EMPTY_RESOURCES };
  for (const hexId of vertex?.adjacentHexIds ?? []) {
    const resource = TERRAIN_RESOURCE[terrainByHex.get(hexId) ?? "desert"];
    if (resource !== undefined) {
      resources[resource] += 1;
    }
  }
  return resources;
};

const settlementEvents = (
  state: GameState,
  command: PlaceInitialSettlementCommand,
): readonly [GameEvent, ...ReadonlyArray<GameEvent>] => {
  const placed: SettlementPlacedEvent = {
    sequence: state.sequence + 1,
    type: "settlement.placed",
    commandId: command.commandId,
    playerId: command.playerId,
    vertexId: command.vertexId,
  };
  if (state.phase.tag !== "setup.settlement" || state.phase.direction === "forward") {
    return [placed];
  }
  const granted: InitialResourcesGrantedEvent = {
    sequence: state.sequence + 2,
    type: "initial-resources.granted",
    commandId: command.commandId,
    playerId: command.playerId,
    resources: startingResources(state, command.vertexId),
  };
  return [placed, granted];
};

const decideSettlement = (
  state: GameState,
  command: PlaceInitialSettlementCommand,
): Effect.Effect<readonly [GameEvent, ...ReadonlyArray<GameEvent>], RuleViolation> => {
  if (state.phase.tag !== "setup.settlement") {
    return failure("wrong-command", "The game is waiting for an initial road.");
  }
  const vertex = state.topology.vertices.find(({ id }) => id === command.vertexId);
  if (vertex === undefined) {
    return failure("unknown-location", "The settlement vertex does not exist.");
  }
  if (state.occupancy.buildings.some((building) => building.vertexId === vertex.id)) {
    return failure("occupied-vertex", "The settlement vertex is occupied.");
  }
  if (!isSettlementLocationLegal(state, command.vertexId)) {
    return failure("settlement-too-close", "A settlement is too close to another settlement.");
  }
  return Effect.succeed(settlementEvents(state, command));
};

const decideRoad = (
  state: GameState,
  command: PlaceInitialRoadCommand,
): Effect.Effect<readonly [GameEvent, ...ReadonlyArray<GameEvent>], RuleViolation> => {
  if (state.phase.tag !== "setup.road") {
    return failure("wrong-command", "The game is waiting for an initial settlement.");
  }
  const edge = state.topology.edges.find(({ id }) => id === command.edgeId);
  if (edge === undefined) {
    return failure("unknown-location", "The road edge does not exist.");
  }
  if (state.occupancy.roads.some((road) => road.edgeId === edge.id)) {
    return failure("occupied-edge", "The road edge is occupied.");
  }
  if (!edge.vertexIds.includes(state.phase.settlementId)) {
    return failure("road-not-adjacent", "The initial road must touch the settlement just placed.");
  }
  const placed: RoadPlacedEvent = {
    sequence: state.sequence + 1,
    type: "road.placed",
    commandId: command.commandId,
    playerId: command.playerId,
    edgeId: command.edgeId,
  };
  if (state.phase.direction !== "reverse" || state.phase.playerIndex !== 0) {
    return Effect.succeed([placed]);
  }
  const completed: InitialPlacementCompletedEvent = {
    sequence: state.sequence + 2,
    type: "initial-placement.completed",
    commandId: command.commandId,
  };
  return Effect.succeed([placed, completed]);
};

export const decide = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<readonly [GameEvent, ...ReadonlyArray<GameEvent>], RuleViolation> =>
  Effect.gen(function* () {
    yield* checkCommonCommand(state, command);
    return yield* command.type === "place-initial-settlement"
      ? decideSettlement(state, command)
      : decideRoad(state, command);
  });

export const handleCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<CommandResult, RuleViolation> =>
  Effect.map(decide(state, command), (events) => ({
    events,
    state: events.reduce(
      (current, event) => applyEvent(current, event as Exclude<GameEvent, GameCreatedEvent>),
      state,
    ),
  }));

const legalSettlementActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> =>
  state.topology.vertices
    .filter((vertex) => isSettlementLocationLegal(state, vertex.id))
    .map((vertex) => ({
      id: `settlement:${vertex.id}`,
      command: {
        type: "place-initial-settlement",
        commandId: `action:${state.sequence + 1}:${vertex.id}`,
        playerId,
        expectedSequence: state.sequence,
        vertexId: vertex.id,
      },
    }));

const legalRoadActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  if (state.phase.tag !== "setup.road") {
    return [];
  }
  const settlementId = state.phase.settlementId;
  return state.topology.edges
    .filter(
      (edge) =>
        edge.vertexIds.includes(settlementId) &&
        !state.occupancy.roads.some((road) => road.edgeId === edge.id),
    )
    .map((edge) => ({
      id: `road:${edge.id}`,
      command: {
        type: "place-initial-road",
        commandId: `action:${state.sequence + 1}:${edge.id}`,
        playerId,
        expectedSequence: state.sequence,
        edgeId: edge.id,
      },
    }));
};

export const legalActions = (state: GameState): ReadonlyArray<LegalAction> => {
  const playerId = currentPlayerId(state);
  if (playerId === null) {
    return [];
  }
  if (state.phase.tag === "setup.settlement") {
    return legalSettlementActions(state, playerId);
  }
  return state.phase.tag === "setup.road" ? legalRoadActions(state, playerId) : [];
};

const resourceTotal = (resources: ResourceCounts): number =>
  resources.lumber + resources.brick + resources.wool + resources.grain + resources.ore;

export const observe = (state: GameState, viewer: Viewer = { type: "public" }): GameObservation => {
  const ownPlayer =
    viewer.type === "player" ? state.players.find(({ id }) => id === viewer.playerId) : undefined;
  return {
    schema: "catanarchy.observation.v1",
    matchId: state.matchId,
    sequence: state.sequence,
    topology: state.topology,
    layout: state.layout,
    occupancy: state.occupancy,
    phase: state.phase,
    activePlayerId: currentPlayerId(state),
    players: state.config.players.map((config) => {
      const player = state.players.find(({ id }) => id === config.id)!;
      const buildings = state.occupancy.buildings.filter(({ playerId }) => playerId === player.id);
      return {
        id: player.id,
        name: config.name,
        color: config.color,
        resourceCount: resourceTotal(player.resources),
        developmentCardCount: player.developmentCards.length,
        settlements: buildings.filter(({ kind }) => kind === "settlement").length,
        cities: buildings.filter(({ kind }) => kind === "city").length,
        roads: state.occupancy.roads.filter(({ playerId }) => playerId === player.id).length,
      };
    }),
    bank: state.bank,
    ownResources: ownPlayer?.resources ?? null,
  };
};

export const replay = (
  events: ReadonlyArray<GameEvent>,
): Effect.Effect<GameState, ReplayViolation> => {
  const first = events[0];
  if (first?.type !== "game.created" || first.sequence !== 0) {
    return Effect.fail(
      new ReplayViolation({ message: "A replay must start with game.created at sequence zero." }),
    );
  }
  let state = first.state;
  for (const event of events.slice(1)) {
    if (event.sequence !== state.sequence + 1 || event.type === "game.created") {
      return Effect.fail(
        new ReplayViolation({ message: "Replay event sequences must be contiguous." }),
      );
    }
    state = applyEvent(state, event);
  }
  return Effect.succeed(state);
};
