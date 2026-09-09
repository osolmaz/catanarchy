import type {
  CommandResult,
  EventEnvelope,
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
import { decodeGameCommand, decodeGameConfig, decodeGameEventEnvelope } from "@catanarchy/protocol";
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
    const event: EventEnvelope<GameCreatedEvent> = {
      schema: "catanarchy.game-event.v1",
      matchId: config.matchId,
      sequence: 0,
      commandId: `create:${config.matchId}`,
      event: { type: "game.created", state },
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

const applySettlement = (
  state: GameState,
  sequence: number,
  event: SettlementPlacedEvent,
): GameState => {
  if (state.phase.tag !== "setup.settlement") {
    return state;
  }
  return {
    ...state,
    sequence,
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
  sequence: number,
  event: InitialResourcesGrantedEvent,
): GameState => ({
  ...state,
  sequence,
  bank: subtractResources(state.bank, event.resources),
  players: updatePlayerResources(state.players, event.playerId, event.resources),
});

const applyRoad = (state: GameState, sequence: number, event: RoadPlacedEvent): GameState => ({
  ...state,
  sequence,
  occupancy: {
    ...state.occupancy,
    roads: [...state.occupancy.roads, { edgeId: event.edgeId, playerId: event.playerId }],
  },
  phase: nextPhaseAfterRoad(state),
});

const applyCompleted = (
  state: GameState,
  sequence: number,
  _event: InitialPlacementCompletedEvent,
): GameState => ({
  ...state,
  sequence,
  phase: { tag: "turn.roll", playerIndex: 0, turn: 1 },
});

export const applyEvent = (state: GameState, envelope: GameEvent): GameState => {
  const { event, sequence } = envelope;
  switch (event.type) {
    case "game.created":
      return state;
    case "settlement.placed":
      return applySettlement(state, sequence, event);
    case "initial-resources.granted":
      return applyInitialResources(state, sequence, event);
    case "road.placed":
      return applyRoad(state, sequence, event);
    case "initial-placement.completed":
      return applyCompleted(state, sequence, event);
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
  if (command.matchId !== state.matchId) {
    return failure("wrong-match", "The command belongs to a different match.");
  }
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

const eventEnvelope = <TEvent>(
  state: GameState,
  command: GameCommand,
  sequence: number,
  event: TEvent,
): EventEnvelope<TEvent> => ({
  schema: "catanarchy.game-event.v1",
  matchId: state.matchId,
  sequence,
  commandId: command.commandId,
  event,
});

const settlementEvents = (
  state: GameState,
  envelope: GameCommand,
  command: PlaceInitialSettlementCommand,
): readonly [GameEvent, ...ReadonlyArray<GameEvent>] => {
  const placed = eventEnvelope(state, envelope, state.sequence + 1, {
    type: "settlement.placed" as const,
    playerId: envelope.playerId,
    vertexId: command.vertexId,
  });
  if (state.phase.tag !== "setup.settlement" || state.phase.direction === "forward") {
    return [placed];
  }
  const granted = eventEnvelope(state, envelope, state.sequence + 2, {
    type: "initial-resources.granted" as const,
    playerId: envelope.playerId,
    resources: startingResources(state, command.vertexId),
  });
  return [placed, granted];
};

const decideSettlement = (
  state: GameState,
  envelope: GameCommand,
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
  return Effect.succeed(settlementEvents(state, envelope, command));
};

const decideRoad = (
  state: GameState,
  envelope: GameCommand,
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
  const placed = eventEnvelope(state, envelope, state.sequence + 1, {
    type: "road.placed" as const,
    playerId: envelope.playerId,
    edgeId: command.edgeId,
  });
  if (state.phase.direction !== "reverse" || state.phase.playerIndex !== 0) {
    return Effect.succeed([placed]);
  }
  const completed = eventEnvelope(state, envelope, state.sequence + 2, {
    type: "initial-placement.completed" as const,
  });
  return Effect.succeed([placed, completed]);
};

export const decide = (
  state: GameState,
  input: GameCommand,
): Effect.Effect<readonly [GameEvent, ...ReadonlyArray<GameEvent>], RuleViolation> =>
  Effect.gen(function* () {
    const command = (yield* decodeGameCommand(input).pipe(
      Effect.mapError(
        () =>
          new RuleViolation({
            code: "invalid-command",
            message: "The command does not match a supported command schema.",
          }),
      ),
    )) as GameCommand;
    yield* checkCommonCommand(state, command);
    return yield* command.command.type === "place-initial-settlement"
      ? decideSettlement(state, command, command.command)
      : decideRoad(state, command, command.command);
  });

export const handleCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<CommandResult, RuleViolation> =>
  Effect.map(decide(state, command), (events) => ({
    events,
    state: events.reduce((current, event) => applyEvent(current, event), state),
  }));

const legalSettlementActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> =>
  state.topology.vertices
    .filter((vertex) => isSettlementLocationLegal(state, vertex.id))
    .map((vertex) => ({
      id: `settlement:${vertex.id}`,
      command: {
        schema: "catanarchy.command.v1",
        matchId: state.matchId,
        commandId: `action:${state.sequence + 1}:${vertex.id}`,
        playerId,
        expectedSequence: state.sequence,
        command: { type: "place-initial-settlement", vertexId: vertex.id },
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
        schema: "catanarchy.command.v1",
        matchId: state.matchId,
        commandId: `action:${state.sequence + 1}:${edge.id}`,
        playerId,
        expectedSequence: state.sequence,
        command: { type: "place-initial-road", edgeId: edge.id },
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

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const commandFromEvent = (state: GameState, envelope: GameEvent): GameCommand | null => {
  const common = {
    schema: "catanarchy.command.v1" as const,
    matchId: envelope.matchId,
    commandId: envelope.commandId,
    expectedSequence: state.sequence,
  };
  switch (envelope.event.type) {
    case "settlement.placed":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "place-initial-settlement", vertexId: envelope.event.vertexId },
      };
    case "road.placed":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "place-initial-road", edgeId: envelope.event.edgeId },
      };
    default:
      return null;
  }
};

const replayFailure = (message: string): ReplayViolation => new ReplayViolation({ message });

export const replay = (events: ReadonlyArray<unknown>): Effect.Effect<GameState, ReplayViolation> =>
  Effect.gen(function* () {
    const first = yield* decodeGameEventEnvelope(events[0]).pipe(
      Effect.mapError(() => replayFailure("The first replay event is malformed.")),
    );
    if (first.sequence !== 0 || first.event.type !== "game.created") {
      return yield* Effect.fail(
        replayFailure("A replay must start with game.created at sequence zero."),
      );
    }
    const created = yield* createGame(first.event.state.config).pipe(
      Effect.mapError(() => replayFailure("The initial game configuration is invalid.")),
    );
    if (!sameCanonicalValue(created.events[0], events[0])) {
      return yield* Effect.fail(replayFailure("The initial game event is invalid."));
    }

    let state = created.state;
    let index = 1;
    while (index < events.length) {
      const decoded = yield* decodeGameEventEnvelope(events[index]).pipe(
        Effect.mapError(() => replayFailure("A replay event is malformed.")),
      );
      const command = commandFromEvent(state, decoded as unknown as GameEvent);
      if (command === null) {
        return yield* Effect.fail(replayFailure("A replay event cannot start a valid command."));
      }
      const expected = yield* decide(state, command).pipe(
        Effect.mapError(() => replayFailure("A replay event violates the game rules.")),
      );
      const actual = events.slice(index, index + expected.length);
      if (!sameCanonicalValue(expected, actual)) {
        return yield* Effect.fail(replayFailure("A replay event batch is invalid."));
      }
      state = expected.reduce((current, event) => applyEvent(current, event), state);
      index += expected.length;
    }
    return state;
  });
