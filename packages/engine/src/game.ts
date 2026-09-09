import type {
  BuildCityCommand,
  BuildRoadCommand,
  BuildSettlementCommand,
  BuyDevelopmentCardCommand,
  CityBuiltEvent,
  CommandResult,
  DevelopmentCardBoughtEvent,
  DiceRolledEvent,
  DiscardResourceCommand,
  EndTurnCommand,
  EventEnvelope,
  GameCommand,
  GameConfig,
  GameCreatedEvent,
  GameEvent,
  GameObservation,
  GamePhase,
  GameState,
  HexId,
  InitialResourcesGrantedEvent,
  KnightPlayedEvent,
  LegalAction,
  MaritimeTradeCommand,
  MaritimeTradeCompletedEvent,
  PlaceFreeRoadCommand,
  PlaceInitialRoadCommand,
  PlaceInitialSettlementCommand,
  PlayKnightCommand,
  PlayMonopolyCommand,
  PlayRoadBuildingCommand,
  PlayYearOfPlentyCommand,
  PlayerId,
  PlayerState,
  Resource,
  ResourceCounts,
  ResourceDiscardedEvent,
  ResourceGrant,
  RoadBuildingPlayedEvent,
  RoadBuiltEvent,
  RoadPlacedEvent,
  RobberMovedEvent,
  RollDiceCommand,
  SettlementBuiltEvent,
  SettlementPlacedEvent,
  Terrain,
  TurnContinuation,
  TurnEndedEvent,
  Viewer,
  YearOfPlentyPlayedEvent,
  MonopolyPlayedEvent,
  FreeRoadPlacedEvent,
  MoveRobberCommand,
} from "@catanarchy/protocol";
import { decodeGameCommand, decodeGameConfig, decodeGameEventEnvelope } from "@catanarchy/protocol";
import { Effect } from "effect";
import { ReplayViolation, RuleViolation } from "./errors.js";
import { generateGameMaterials } from "./layout.js";
import { deriveRandomState, nextInt } from "./random.js";
import { STANDARD_TOPOLOGY } from "./topology.js";

const RESOURCE_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;
const EMPTY_RESOURCES: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const FULL_BANK: ResourceCounts = { lumber: 19, brick: 19, wool: 19, grain: 19, ore: 19 };
const ROAD_COST: ResourceCounts = { lumber: 1, brick: 1, wool: 0, grain: 0, ore: 0 };
const SETTLEMENT_COST: ResourceCounts = { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 };
const CITY_COST: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 2, ore: 3 };
const DEVELOPMENT_CARD_COST: ResourceCounts = {
  lumber: 0,
  brick: 0,
  wool: 1,
  grain: 1,
  ore: 1,
};
const TERRAIN_RESOURCE: Readonly<Partial<Record<Terrain, Resource>>> = {
  forest: "lumber",
  hill: "brick",
  pasture: "wool",
  field: "grain",
  mountain: "ore",
};

type EventBatch = readonly [GameEvent, ...ReadonlyArray<GameEvent>];

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
      developmentDiscard: [],
      phase: { tag: "setup.settlement", direction: "forward", playerIndex: 0 },
      random: {
        board: materials.boardRandom,
        developmentDeck: materials.developmentDeckRandom,
        dice: deriveRandomState(config.seed, "dice"),
        resourceSteal: deriveRandomState(config.seed, "resource-steal"),
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

const resourceAmount = (resource: Resource, amount: number): ResourceCounts => ({
  ...EMPTY_RESOURCES,
  [resource]: amount,
});

const hasResources = (available: ResourceCounts, needed: ResourceCounts): boolean =>
  RESOURCE_KEYS.every((resource) => available[resource] >= needed[resource]);

const resourceTotal = (resources: ResourceCounts): number =>
  RESOURCE_KEYS.reduce((total, resource) => total + resources[resource], 0);

const playerById = (state: GameState, playerId: PlayerId): PlayerState | undefined =>
  state.players.find(({ id }) => id === playerId);

const updatePlayer = (
  players: ReadonlyArray<PlayerState>,
  playerId: PlayerId,
  update: (player: PlayerState) => PlayerState,
): ReadonlyArray<PlayerState> =>
  players.map((player) => (player.id === playerId ? update(player) : player));

const updatePlayerResources = (
  players: ReadonlyArray<PlayerState>,
  playerId: PlayerId,
  resources: ResourceCounts,
): ReadonlyArray<PlayerState> =>
  updatePlayer(players, playerId, (player) => ({
    ...player,
    resources: addResources(player.resources, resources),
  }));

const spendPlayerResources = (
  players: ReadonlyArray<PlayerState>,
  playerId: PlayerId,
  cost: ResourceCounts,
): ReadonlyArray<PlayerState> =>
  updatePlayer(players, playerId, (player) => ({
    ...player,
    resources: subtractResources(player.resources, cost),
  }));

const nextPhaseAfterRoad = (state: GameState): GamePhase => {
  if (state.phase.tag !== "setup.road") return state.phase;
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
  if (state.phase.tag !== "setup.settlement") return state;
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

const applyCompleted = (state: GameState, sequence: number): GameState => ({
  ...state,
  sequence,
  phase: { tag: "turn.roll", playerIndex: 0, turn: 1, developmentCardPlayed: false },
});

const totalGrants = (grants: ReadonlyArray<ResourceGrant>): ResourceCounts =>
  grants.reduce((total, grant) => addResources(total, grant.resources), EMPTY_RESOURCES);

const discardQueue = (
  state: GameState,
): ReadonlyArray<{ readonly playerIndex: number; readonly remaining: number }> =>
  state.players.flatMap((player, playerIndex) => {
    const cards = resourceTotal(player.resources);
    return cards > 7 ? [{ playerIndex, remaining: Math.floor(cards / 2) }] : [];
  });

const phaseAfterSeven = (
  state: GameState,
  dice: readonly [number, number],
  turn: number,
  developmentCardPlayed: boolean,
): GamePhase => {
  const queue = discardQueue(state);
  const first = queue[0];
  if (first !== undefined) {
    return {
      tag: "turn.discard",
      playerIndex: first.playerIndex,
      rollerIndex: state.phase.playerIndex,
      turn,
      dice,
      remaining: first.remaining,
      queue: queue.slice(1),
      developmentCardPlayed,
    };
  }
  return {
    tag: "turn.robber",
    playerIndex: state.phase.playerIndex,
    turn,
    source: "roll",
    continuation: { tag: "turn.action", dice },
    developmentCardPlayed,
  };
};

const applyDiceRolled = (state: GameState, sequence: number, event: DiceRolledEvent): GameState => {
  if (state.phase.tag !== "turn.roll") return state;
  const players = event.grants.reduce(
    (current, grant) => updatePlayerResources(current, grant.playerId, grant.resources),
    state.players,
  );
  const reduced: GameState = {
    ...state,
    sequence,
    random: { ...state.random, dice: event.nextRandom },
    bank: subtractResources(state.bank, totalGrants(event.grants)),
    players,
  };
  return {
    ...reduced,
    phase:
      event.dice[0] + event.dice[1] === 7
        ? phaseAfterSeven(reduced, event.dice, state.phase.turn, state.phase.developmentCardPlayed)
        : {
            tag: "turn.action",
            playerIndex: state.phase.playerIndex,
            turn: state.phase.turn,
            dice: event.dice,
            developmentCardPlayed: state.phase.developmentCardPlayed,
          },
  };
};

const applyRoadBuilt = (state: GameState, sequence: number, event: RoadBuiltEvent): GameState => ({
  ...state,
  sequence,
  bank: addResources(state.bank, ROAD_COST),
  players: spendPlayerResources(state.players, event.playerId, ROAD_COST),
  occupancy: {
    ...state.occupancy,
    roads: [...state.occupancy.roads, { edgeId: event.edgeId, playerId: event.playerId }],
  },
});

const applySettlementBuilt = (
  state: GameState,
  sequence: number,
  event: SettlementBuiltEvent,
): GameState => ({
  ...state,
  sequence,
  bank: addResources(state.bank, SETTLEMENT_COST),
  players: spendPlayerResources(state.players, event.playerId, SETTLEMENT_COST),
  occupancy: {
    ...state.occupancy,
    buildings: [
      ...state.occupancy.buildings,
      { vertexId: event.vertexId, playerId: event.playerId, kind: "settlement" },
    ],
  },
});

const applyCityBuilt = (state: GameState, sequence: number, event: CityBuiltEvent): GameState => ({
  ...state,
  sequence,
  bank: addResources(state.bank, CITY_COST),
  players: spendPlayerResources(state.players, event.playerId, CITY_COST),
  occupancy: {
    ...state.occupancy,
    buildings: state.occupancy.buildings.map((building) =>
      building.vertexId === event.vertexId ? { ...building, kind: "city" } : building,
    ),
  },
});

const applyDevelopmentCardBought = (
  state: GameState,
  sequence: number,
  event: DevelopmentCardBoughtEvent,
): GameState => ({
  ...state,
  sequence,
  bank: addResources(state.bank, DEVELOPMENT_CARD_COST),
  players: updatePlayer(state.players, event.playerId, (player) => ({
    ...player,
    resources: subtractResources(player.resources, DEVELOPMENT_CARD_COST),
    developmentCards: [
      ...player.developmentCards,
      { card: event.card, purchasedTurn: event.purchasedTurn },
    ],
  })),
  developmentDeck: state.developmentDeck.slice(1),
});

const applyMaritimeTrade = (
  state: GameState,
  sequence: number,
  event: MaritimeTradeCompletedEvent,
): GameState => {
  const given = resourceAmount(event.give, event.rate);
  const received = resourceAmount(event.receive, 1);
  return {
    ...state,
    sequence,
    bank: addResources(subtractResources(state.bank, received), given),
    players: updatePlayer(state.players, event.playerId, (player) => ({
      ...player,
      resources: addResources(subtractResources(player.resources, given), received),
    })),
  };
};

const applyTurnEnded = (state: GameState, sequence: number, event: TurnEndedEvent): GameState => ({
  ...state,
  sequence,
  phase: {
    tag: "turn.roll",
    playerIndex: event.nextPlayerIndex,
    turn: event.nextTurn,
    developmentCardPlayed: false,
  },
});

const continuationFromPhase = (phase: GamePhase): TurnContinuation => {
  switch (phase.tag) {
    case "turn.roll":
      return { tag: "turn.roll" };
    case "turn.action":
      return { tag: "turn.action", dice: phase.dice };
    case "turn.robber":
      return { tag: "turn.robber", source: phase.source, continuation: phase.continuation };
    default:
      throw new Error("The current phase cannot be suspended.");
  }
};

const resumePhase = (
  playerIndex: number,
  turn: number,
  developmentCardPlayed: boolean,
  continuation: TurnContinuation,
): GamePhase => {
  switch (continuation.tag) {
    case "turn.roll":
      return { tag: "turn.roll", playerIndex, turn, developmentCardPlayed };
    case "turn.action":
      return {
        tag: "turn.action",
        playerIndex,
        turn,
        dice: continuation.dice,
        developmentCardPlayed,
      };
    case "turn.robber":
      return {
        tag: "turn.robber",
        playerIndex,
        turn,
        source: continuation.source,
        continuation: continuation.continuation,
        developmentCardPlayed,
      };
  }
};

const removeDevelopmentCard = (
  players: ReadonlyArray<PlayerState>,
  playerId: PlayerId,
  card: PlayerState["developmentCards"][number]["card"],
  playedKnight: boolean,
): ReadonlyArray<PlayerState> =>
  updatePlayer(players, playerId, (player) => {
    const index = player.developmentCards.findIndex((owned) => owned.card === card);
    return {
      ...player,
      developmentCards: player.developmentCards.filter((_owned, cardIndex) => cardIndex !== index),
      playedKnights: player.playedKnights + (playedKnight ? 1 : 0),
    };
  });

const phaseWithDevelopmentCardPlayed = (phase: GamePhase): GamePhase => {
  switch (phase.tag) {
    case "turn.roll":
    case "turn.action":
    case "turn.robber":
      return { ...phase, developmentCardPlayed: true };
    default:
      return phase;
  }
};

const applyResourceDiscarded = (
  state: GameState,
  sequence: number,
  event: ResourceDiscardedEvent,
): GameState => {
  if (state.phase.tag !== "turn.discard") return state;
  const returned = resourceAmount(event.resource, 1);
  const reduced = {
    ...state,
    sequence,
    bank: addResources(state.bank, returned),
    players: spendPlayerResources(state.players, event.playerId, returned),
  };
  if (state.phase.remaining > 1) {
    return { ...reduced, phase: { ...state.phase, remaining: state.phase.remaining - 1 } };
  }
  const next = state.phase.queue[0];
  if (next !== undefined) {
    return {
      ...reduced,
      phase: {
        ...state.phase,
        playerIndex: next.playerIndex,
        remaining: next.remaining,
        queue: state.phase.queue.slice(1),
      },
    };
  }
  return {
    ...reduced,
    phase: {
      tag: "turn.robber",
      playerIndex: state.phase.rollerIndex,
      turn: state.phase.turn,
      source: "roll",
      continuation: { tag: "turn.action", dice: state.phase.dice },
      developmentCardPlayed: state.phase.developmentCardPlayed,
    },
  };
};

const transferStolenResource = (
  players: ReadonlyArray<PlayerState>,
  thiefId: PlayerId,
  victimId: PlayerId | null,
  resource: Resource | null,
): ReadonlyArray<PlayerState> => {
  if (victimId === null || resource === null) return players;
  const card = resourceAmount(resource, 1);
  const withoutVictim = spendPlayerResources(players, victimId, card);
  return updatePlayerResources(withoutVictim, thiefId, card);
};

const applyRobberMoved = (
  state: GameState,
  sequence: number,
  event: RobberMovedEvent,
): GameState => {
  if (state.phase.tag !== "turn.robber") return state;
  return {
    ...state,
    sequence,
    layout: { ...state.layout, robberHexId: event.toHexId },
    players: transferStolenResource(
      state.players,
      event.playerId,
      event.victimPlayerId,
      event.stolenResource,
    ),
    random: { ...state.random, resourceSteal: event.nextRandom },
    phase: resumePhase(
      state.phase.playerIndex,
      state.phase.turn,
      state.phase.developmentCardPlayed,
      state.phase.continuation,
    ),
  };
};

const applyKnightPlayed = (
  state: GameState,
  sequence: number,
  event: KnightPlayedEvent,
): GameState => ({
  ...state,
  sequence,
  players: removeDevelopmentCard(state.players, event.playerId, "knight", true),
  phase: {
    tag: "turn.robber",
    playerIndex: state.phase.playerIndex,
    turn: "turn" in state.phase ? state.phase.turn : 1,
    source: "knight",
    continuation: continuationFromPhase(state.phase),
    developmentCardPlayed: true,
  },
});

const applyRoadBuildingPlayed = (
  state: GameState,
  sequence: number,
  event: RoadBuildingPlayedEvent,
): GameState => {
  const continuation = continuationFromPhase(state.phase);
  const turn = "turn" in state.phase ? state.phase.turn : 1;
  return {
    ...state,
    sequence,
    players: removeDevelopmentCard(state.players, event.playerId, "road-building", false),
    developmentDiscard: [...state.developmentDiscard, "road-building"],
    phase:
      event.roadsToPlace === 0
        ? resumePhase(state.phase.playerIndex, turn, true, continuation)
        : {
            tag: "turn.free-road",
            playerIndex: state.phase.playerIndex,
            turn,
            remaining: event.roadsToPlace,
            continuation,
            developmentCardPlayed: true,
          },
  };
};

const hasFreeRoadPlacement = (state: GameState, playerId: PlayerId): boolean =>
  playerRoadCount(state, playerId) < 15 &&
  state.topology.edges.some((edge) => canBuildRoadAt(state, playerId, edge.id));

const applyFreeRoadPlaced = (
  state: GameState,
  sequence: number,
  event: FreeRoadPlacedEvent,
): GameState => {
  if (state.phase.tag !== "turn.free-road") return state;
  const reduced: GameState = {
    ...state,
    sequence,
    occupancy: {
      ...state.occupancy,
      roads: [...state.occupancy.roads, { edgeId: event.edgeId, playerId: event.playerId }],
    },
  };
  return {
    ...reduced,
    phase:
      state.phase.remaining > 1 && hasFreeRoadPlacement(reduced, event.playerId)
        ? { ...state.phase, remaining: 1 }
        : resumePhase(state.phase.playerIndex, state.phase.turn, true, state.phase.continuation),
  };
};

const applyYearOfPlentyPlayed = (
  state: GameState,
  sequence: number,
  event: YearOfPlentyPlayedEvent,
): GameState => ({
  ...state,
  sequence,
  bank: subtractResources(state.bank, event.granted),
  players: updatePlayerResources(
    removeDevelopmentCard(state.players, event.playerId, "year-of-plenty", false),
    event.playerId,
    event.granted,
  ),
  developmentDiscard: [...state.developmentDiscard, "year-of-plenty"],
  phase: phaseWithDevelopmentCardPlayed(state.phase),
});

const applyMonopolyPlayed = (
  state: GameState,
  sequence: number,
  event: MonopolyPlayedEvent,
): GameState => {
  const total = event.transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
  const withoutOpponents = event.transfers.reduce(
    (players, transfer) =>
      spendPlayerResources(
        players,
        transfer.playerId,
        resourceAmount(event.resource, transfer.amount),
      ),
    removeDevelopmentCard(state.players, event.playerId, "monopoly", false),
  );
  return {
    ...state,
    sequence,
    players: updatePlayerResources(
      withoutOpponents,
      event.playerId,
      resourceAmount(event.resource, total),
    ),
    developmentDiscard: [...state.developmentDiscard, "monopoly"],
    phase: phaseWithDevelopmentCardPlayed(state.phase),
  };
};

const applySetupEvent = (state: GameState, envelope: GameEvent): GameState | undefined => {
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
      return applyCompleted(state, sequence);
    default:
      return undefined;
  }
};

const applyNormalEvent = (state: GameState, envelope: GameEvent): GameState | undefined => {
  const { event, sequence } = envelope;
  switch (event.type) {
    case "dice.rolled":
      return applyDiceRolled(state, sequence, event);
    case "road.built":
      return applyRoadBuilt(state, sequence, event);
    case "settlement.built":
      return applySettlementBuilt(state, sequence, event);
    case "city.built":
      return applyCityBuilt(state, sequence, event);
    case "development-card.bought":
      return applyDevelopmentCardBought(state, sequence, event);
    case "maritime-trade.completed":
      return applyMaritimeTrade(state, sequence, event);
    case "turn.ended":
      return applyTurnEnded(state, sequence, event);
    default:
      return undefined;
  }
};

const applyEffectEvent = (state: GameState, envelope: GameEvent): GameState | undefined => {
  const { event, sequence } = envelope;
  switch (event.type) {
    case "resource.discarded":
      return applyResourceDiscarded(state, sequence, event);
    case "robber.moved":
      return applyRobberMoved(state, sequence, event);
    case "knight.played":
      return applyKnightPlayed(state, sequence, event);
    case "road-building.played":
      return applyRoadBuildingPlayed(state, sequence, event);
    case "free-road.placed":
      return applyFreeRoadPlaced(state, sequence, event);
    case "year-of-plenty.played":
      return applyYearOfPlentyPlayed(state, sequence, event);
    case "monopoly.played":
      return applyMonopolyPlayed(state, sequence, event);
    default:
      return undefined;
  }
};

export const applyEvent = (state: GameState, envelope: GameEvent): GameState =>
  applySetupEvent(state, envelope) ??
  applyNormalEvent(state, envelope) ??
  applyEffectEvent(state, envelope) ??
  state;

const currentPlayerId = (state: GameState): PlayerId | null =>
  state.config.players[state.phase.playerIndex]?.id ?? null;

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
    return failure("wrong-player", "Only the active player can take an action.");
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
  let resources = EMPTY_RESOURCES;
  for (const hexId of vertex?.adjacentHexIds ?? []) {
    const resource = TERRAIN_RESOURCE[terrainByHex.get(hexId) ?? "desert"];
    if (resource !== undefined) resources = addResources(resources, resourceAmount(resource, 1));
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
): EventBatch => {
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
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "setup.settlement") {
    return failure("wrong-command", "The game is not waiting for an initial settlement.");
  }
  const vertex = state.topology.vertices.find(({ id }) => id === command.vertexId);
  if (vertex === undefined)
    return failure("unknown-location", "The settlement vertex does not exist.");
  if (state.occupancy.buildings.some((building) => building.vertexId === vertex.id)) {
    return failure("occupied-vertex", "The settlement vertex is occupied.");
  }
  if (!isSettlementLocationLegal(state, command.vertexId)) {
    return failure("settlement-too-close", "A settlement is too close to another settlement.");
  }
  return Effect.succeed(settlementEvents(state, envelope, command));
};

const decideInitialRoad = (
  state: GameState,
  envelope: GameCommand,
  command: PlaceInitialRoadCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "setup.road") {
    return failure("wrong-command", "The game is not waiting for an initial road.");
  }
  const edge = state.topology.edges.find(({ id }) => id === command.edgeId);
  if (edge === undefined) return failure("unknown-location", "The road edge does not exist.");
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
  return Effect.succeed([
    placed,
    eventEnvelope(state, envelope, state.sequence + 2, {
      type: "initial-placement.completed" as const,
    }),
  ]);
};

interface ProductionResult {
  readonly grants: ReadonlyArray<ResourceGrant>;
  readonly shortages: ReadonlyArray<Resource>;
}

const producedResource = (
  state: GameState,
  hexId: string,
  number: number,
  numbers: ReadonlyMap<string, number>,
  terrain: ReadonlyMap<string, Terrain>,
): Resource | undefined => {
  if (hexId === state.layout.robberHexId) return undefined;
  if (numbers.get(hexId) !== number) return undefined;
  return TERRAIN_RESOURCE[terrain.get(hexId) ?? "desert"];
};

const productionClaims = (state: GameState, number: number): ReadonlyArray<ResourceGrant> => {
  const numbers = new Map(
    state.layout.numbers.map((placement) => [placement.hexId, placement.number]),
  );
  const terrain = new Map(
    state.layout.terrain.map((placement) => [placement.hexId, placement.terrain]),
  );
  const claims = new Map<PlayerId, ResourceCounts>();
  for (const building of state.occupancy.buildings) {
    const vertex = state.topology.vertices.find(({ id }) => id === building.vertexId);
    const production = building.kind === "city" ? 2 : 1;
    const adjacentHexIds = vertex === undefined ? [] : vertex.adjacentHexIds;
    for (const hexId of adjacentHexIds) {
      const resource = producedResource(state, hexId, number, numbers, terrain);
      if (resource === undefined) continue;
      const current = claims.get(building.playerId) ?? EMPTY_RESOURCES;
      claims.set(building.playerId, addResources(current, resourceAmount(resource, production)));
    }
  }
  return state.players
    .map((player) => ({ playerId: player.id, resources: claims.get(player.id) ?? EMPTY_RESOURCES }))
    .filter(({ resources }) => RESOURCE_KEYS.some((resource) => resources[resource] > 0));
};

const resolveProduction = (state: GameState, number: number): ProductionResult => {
  const claims = productionClaims(state, number);
  const shortages: Resource[] = [];
  const granted = new Map<PlayerId, ResourceCounts>();
  for (const resource of RESOURCE_KEYS) {
    const claimants = claims.filter(({ resources }) => resources[resource] > 0);
    const total = claimants.reduce((sum, claim) => sum + claim.resources[resource], 0);
    if (total <= state.bank[resource]) {
      for (const claim of claimants) {
        const current = granted.get(claim.playerId) ?? EMPTY_RESOURCES;
        granted.set(
          claim.playerId,
          addResources(current, resourceAmount(resource, claim.resources[resource])),
        );
      }
    } else if (claimants.length === 1) {
      const claim = claimants[0]!;
      const current = granted.get(claim.playerId) ?? EMPTY_RESOURCES;
      granted.set(
        claim.playerId,
        addResources(current, resourceAmount(resource, state.bank[resource])),
      );
      shortages.push(resource);
    } else {
      shortages.push(resource);
    }
  }
  return {
    grants: state.players
      .map(({ id }) => ({ playerId: id, resources: granted.get(id) ?? EMPTY_RESOURCES }))
      .filter(({ resources }) => RESOURCE_KEYS.some((resource) => resources[resource] > 0)),
    shortages,
  };
};

const decideRollDice = (
  state: GameState,
  envelope: GameCommand,
  _command: RollDiceCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "turn.roll") {
    return failure("wrong-command", "Dice can only be rolled at the start of a turn.");
  }
  const first = nextInt(state.random.dice, 6);
  const second = nextInt(first.state, 6);
  const dice = [first.value + 1, second.value + 1] as const;
  const production =
    dice[0] + dice[1] === 7
      ? { grants: [], shortages: [] }
      : resolveProduction(state, dice[0] + dice[1]);
  return Effect.succeed([
    eventEnvelope(state, envelope, state.sequence + 1, {
      type: "dice.rolled" as const,
      playerId: envelope.playerId,
      dice,
      nextRandom: second.state,
      grants: production.grants,
      shortages: production.shortages,
    }),
  ]);
};

const isActionPhase = (state: GameState): boolean => state.phase.tag === "turn.action";

const playerCanAfford = (state: GameState, playerId: PlayerId, cost: ResourceCounts): boolean => {
  const player = playerById(state, playerId);
  return player !== undefined && hasResources(player.resources, cost);
};

const playerRoadCount = (state: GameState, playerId: PlayerId): number =>
  state.occupancy.roads.filter((road) => road.playerId === playerId).length;

const playerBuildingCount = (
  state: GameState,
  playerId: PlayerId,
  kind: "settlement" | "city",
): number =>
  state.occupancy.buildings.filter(
    (building) => building.playerId === playerId && building.kind === kind,
  ).length;

const roadEndpointConnects = (state: GameState, playerId: PlayerId, vertexId: string): boolean => {
  const building = state.occupancy.buildings.find((candidate) => candidate.vertexId === vertexId);
  if (building?.playerId === playerId) return true;
  if (building !== undefined) return false;
  return state.occupancy.roads.some((road) => {
    if (road.playerId !== playerId) return false;
    const edge = state.topology.edges.find(({ id }) => id === road.edgeId);
    return edge?.vertexIds.includes(vertexId as never) ?? false;
  });
};

const canBuildRoadAt = (state: GameState, playerId: PlayerId, edgeId: string): boolean => {
  const edge = state.topology.edges.find(({ id }) => id === edgeId);
  return (
    edge !== undefined &&
    !state.occupancy.roads.some((road) => road.edgeId === edgeId) &&
    edge.vertexIds.some((vertexId) => roadEndpointConnects(state, playerId, vertexId))
  );
};

const canBuildSettlementAt = (state: GameState, playerId: PlayerId, vertexId: string): boolean => {
  if (!isSettlementLocationLegal(state, vertexId)) return false;
  const vertex = state.topology.vertices.find(({ id }) => id === vertexId);
  return (
    vertex?.edgeIds.some((edgeId) =>
      state.occupancy.roads.some((road) => road.edgeId === edgeId && road.playerId === playerId),
    ) ?? false
  );
};

const actionEvent = <TEvent>(state: GameState, command: GameCommand, event: TEvent): EventBatch => [
  eventEnvelope(state, command, state.sequence + 1, event) as GameEvent,
];

const requireActionPhase = (state: GameState): Effect.Effect<void, RuleViolation> =>
  isActionPhase(state)
    ? Effect.void
    : failure("wrong-command", "This action is only available after a non-seven roll.");

const decideBuildRoad = (
  state: GameState,
  envelope: GameCommand,
  command: BuildRoadCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    if (!state.topology.edges.some(({ id }) => id === command.edgeId)) {
      return yield* failure("unknown-location", "The road edge does not exist.");
    }
    if (state.occupancy.roads.some(({ edgeId }) => edgeId === command.edgeId)) {
      return yield* failure("occupied-edge", "The road edge is occupied.");
    }
    if (playerRoadCount(state, envelope.playerId) >= 15) {
      return yield* failure("piece-supply", "The player has no road piece available.");
    }
    if (!playerCanAfford(state, envelope.playerId, ROAD_COST)) {
      return yield* failure("insufficient-resources", "The player cannot pay the road cost.");
    }
    if (!canBuildRoadAt(state, envelope.playerId, command.edgeId)) {
      return yield* failure("disconnected-route", "The road must connect to the player's route.");
    }
    return actionEvent(state, envelope, {
      type: "road.built" as const,
      playerId: envelope.playerId,
      edgeId: command.edgeId,
    });
  });

const decideBuildSettlement = (
  state: GameState,
  envelope: GameCommand,
  command: BuildSettlementCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    if (!state.topology.vertices.some(({ id }) => id === command.vertexId)) {
      return yield* failure("unknown-location", "The settlement vertex does not exist.");
    }
    if (state.occupancy.buildings.some(({ vertexId }) => vertexId === command.vertexId)) {
      return yield* failure("occupied-vertex", "The settlement vertex is occupied.");
    }
    if (playerBuildingCount(state, envelope.playerId, "settlement") >= 5) {
      return yield* failure("piece-supply", "The player has no settlement piece available.");
    }
    if (!playerCanAfford(state, envelope.playerId, SETTLEMENT_COST)) {
      return yield* failure("insufficient-resources", "The player cannot pay the settlement cost.");
    }
    if (!canBuildSettlementAt(state, envelope.playerId, command.vertexId)) {
      return yield* failure(
        "disconnected-route",
        "The settlement must satisfy distance and route rules.",
      );
    }
    return actionEvent(state, envelope, {
      type: "settlement.built" as const,
      playerId: envelope.playerId,
      vertexId: command.vertexId,
    });
  });

const decideBuildCity = (
  state: GameState,
  envelope: GameCommand,
  command: BuildCityCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    const building = state.occupancy.buildings.find(
      ({ vertexId }) => vertexId === command.vertexId,
    );
    if (building === undefined)
      return yield* failure("unknown-location", "No settlement exists there.");
    if (building.playerId !== envelope.playerId || building.kind !== "settlement") {
      return yield* failure("wrong-player", "A player can upgrade only their own settlement.");
    }
    if (playerBuildingCount(state, envelope.playerId, "city") >= 4) {
      return yield* failure("piece-supply", "The player has no city piece available.");
    }
    if (!playerCanAfford(state, envelope.playerId, CITY_COST)) {
      return yield* failure("insufficient-resources", "The player cannot pay the city cost.");
    }
    return actionEvent(state, envelope, {
      type: "city.built" as const,
      playerId: envelope.playerId,
      vertexId: command.vertexId,
    });
  });

const decideBuyDevelopmentCard = (
  state: GameState,
  envelope: GameCommand,
  _command: BuyDevelopmentCardCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    const card = state.developmentDeck[0];
    if (card === undefined) {
      return yield* failure("development-deck-empty", "The development deck is empty.");
    }
    if (!playerCanAfford(state, envelope.playerId, DEVELOPMENT_CARD_COST)) {
      return yield* failure(
        "insufficient-resources",
        "The player cannot pay the development-card cost.",
      );
    }
    return actionEvent(state, envelope, {
      type: "development-card.bought" as const,
      playerId: envelope.playerId,
      card,
      purchasedTurn: state.phase.tag === "turn.action" ? state.phase.turn : 1,
    });
  });

const maritimeRate = (state: GameState, playerId: PlayerId, give: Resource): 2 | 3 | 4 => {
  let rate: 2 | 3 | 4 = 4;
  for (const harbor of state.layout.harbors) {
    const edge = state.topology.edges.find(({ id }) => id === harbor.edgeId);
    const ownsHarbor = edge?.vertexIds.some((vertexId) =>
      state.occupancy.buildings.some(
        (building) => building.vertexId === vertexId && building.playerId === playerId,
      ),
    );
    if (!ownsHarbor) continue;
    if (harbor.kind === give) return 2;
    if (harbor.kind === "generic") rate = 3;
  }
  return rate;
};

const canMaritimeTrade = (
  state: GameState,
  playerId: PlayerId,
  give: Resource,
  receive: Resource,
): boolean => {
  const player = playerById(state, playerId);
  return (
    give !== receive &&
    player !== undefined &&
    player.resources[give] >= maritimeRate(state, playerId, give) &&
    state.bank[receive] >= 1
  );
};

const decideMaritimeTrade = (
  state: GameState,
  envelope: GameCommand,
  command: MaritimeTradeCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    if (!canMaritimeTrade(state, envelope.playerId, command.give, command.receive)) {
      return yield* failure("invalid-trade", "The maritime trade cannot be completed.");
    }
    return actionEvent(state, envelope, {
      type: "maritime-trade.completed" as const,
      playerId: envelope.playerId,
      give: command.give,
      receive: command.receive,
      rate: maritimeRate(state, envelope.playerId, command.give),
    });
  });

const decideEndTurn = (
  state: GameState,
  envelope: GameCommand,
  _command: EndTurnCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.gen(function* () {
    yield* requireActionPhase(state);
    const phase = state.phase;
    if (phase.tag !== "turn.action") {
      return yield* failure("wrong-command", "The turn cannot end in this phase.");
    }
    return actionEvent(state, envelope, {
      type: "turn.ended" as const,
      playerId: envelope.playerId,
      nextPlayerIndex: (phase.playerIndex + 1) % state.players.length,
      nextTurn: phase.turn + 1,
    });
  });

const decideDiscardResource = (
  state: GameState,
  envelope: GameCommand,
  command: DiscardResourceCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "turn.discard") {
    return failure("wrong-command", "No resource discard is pending.");
  }
  const player = playerById(state, envelope.playerId);
  if (player === undefined || player.resources[command.resource] < 1) {
    return failure("invalid-discard", "The player does not hold that resource card.");
  }
  return Effect.succeed(
    actionEvent(state, envelope, {
      type: "resource.discarded" as const,
      playerId: envelope.playerId,
      resource: command.resource,
    }),
  );
};

const robberVictims = (
  state: GameState,
  hexId: HexId,
  playerId: PlayerId,
): ReadonlyArray<PlayerId> => {
  const hex = state.topology.hexes.find(({ id }) => id === hexId);
  if (hex === undefined) return [];
  const vertexIds = new Set(hex.vertexIds);
  return state.players
    .filter(
      (player) =>
        player.id !== playerId &&
        state.occupancy.buildings.some(
          (building) => building.playerId === player.id && vertexIds.has(building.vertexId),
        ),
    )
    .map(({ id }) => id);
};

const randomlySelectedResource = (
  resources: ResourceCounts,
  random: GameState["random"]["resourceSteal"],
): { readonly resource: Resource | null; readonly nextRandom: typeof random } => {
  const total = resourceTotal(resources);
  if (total === 0) return { resource: null, nextRandom: random };
  const selected = nextInt(random, total);
  let offset = selected.value;
  for (const resource of RESOURCE_KEYS) {
    if (offset < resources[resource]) return { resource, nextRandom: selected.state };
    offset -= resources[resource];
  }
  throw new Error("The selected resource index is invalid.");
};

const validRobberVictim = (
  victims: ReadonlyArray<PlayerId>,
  victimPlayerId: PlayerId | null,
): boolean =>
  victims.length === 0
    ? victimPlayerId === null
    : victimPlayerId !== null && victims.includes(victimPlayerId);

const validateRobberMove = (
  state: GameState,
  playerId: PlayerId,
  command: MoveRobberCommand,
): Effect.Effect<void, RuleViolation> => {
  if (!state.topology.hexes.some(({ id }) => id === command.hexId)) {
    return failure("unknown-location", "The robber destination does not exist.");
  }
  if (command.hexId === state.layout.robberHexId) {
    return failure("robber-must-move", "The robber must move to a different hex.");
  }
  const victims = robberVictims(state, command.hexId, playerId);
  return validRobberVictim(victims, command.victimPlayerId)
    ? Effect.void
    : failure("invalid-victim", "The robber action must name an eligible victim.");
};

const selectedRobberResource = (
  state: GameState,
  victimPlayerId: PlayerId | null,
): ReturnType<typeof randomlySelectedResource> => {
  const victim = victimPlayerId === null ? undefined : playerById(state, victimPlayerId);
  return randomlySelectedResource(victim?.resources ?? EMPTY_RESOURCES, state.random.resourceSteal);
};

const decideMoveRobber = (
  state: GameState,
  envelope: GameCommand,
  command: MoveRobberCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "turn.robber") {
    return failure("wrong-command", "No robber move is pending.");
  }
  return Effect.map(validateRobberMove(state, envelope.playerId, command), () => {
    const selected = selectedRobberResource(state, command.victimPlayerId);
    return actionEvent(state, envelope, {
      type: "robber.moved" as const,
      playerId: envelope.playerId,
      fromHexId: state.layout.robberHexId,
      toHexId: command.hexId,
      victimPlayerId: command.victimPlayerId,
      stolenResource: selected.resource,
      nextRandom: selected.nextRandom,
    });
  });
};

const developmentPhase = (
  state: GameState,
):
  | Extract<GamePhase, { readonly tag: "turn.roll" | "turn.action" | "turn.robber" }>
  | undefined => {
  const phase = state.phase;
  return phase.tag === "turn.roll" || phase.tag === "turn.action" || phase.tag === "turn.robber"
    ? phase
    : undefined;
};

const canPlayDevelopmentCard = (
  state: GameState,
  playerId: PlayerId,
  card: PlayerState["developmentCards"][number]["card"],
): boolean => {
  const phase = developmentPhase(state);
  const player = playerById(state, playerId);
  return (
    phase !== undefined &&
    !phase.developmentCardPlayed &&
    (player?.developmentCards.some(
      (owned) => owned.card === card && owned.purchasedTurn < phase.turn,
    ) ??
      false)
  );
};

const requireDevelopmentCard = (
  state: GameState,
  playerId: PlayerId,
  card: PlayerState["developmentCards"][number]["card"],
): Effect.Effect<void, RuleViolation> =>
  canPlayDevelopmentCard(state, playerId, card)
    ? Effect.void
    : failure(
        "development-card-unavailable",
        "The development card cannot be played in the current turn.",
      );

const decidePlayKnight = (
  state: GameState,
  envelope: GameCommand,
  _command: PlayKnightCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.map(requireDevelopmentCard(state, envelope.playerId, "knight"), () =>
    actionEvent(state, envelope, {
      type: "knight.played" as const,
      playerId: envelope.playerId,
    }),
  );

const freeRoadCount = (state: GameState, playerId: PlayerId): 0 | 1 | 2 => {
  if (!hasFreeRoadPlacement(state, playerId)) return 0;
  return playerRoadCount(state, playerId) === 14 ? 1 : 2;
};

const decidePlayRoadBuilding = (
  state: GameState,
  envelope: GameCommand,
  _command: PlayRoadBuildingCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.map(requireDevelopmentCard(state, envelope.playerId, "road-building"), () =>
    actionEvent(state, envelope, {
      type: "road-building.played" as const,
      playerId: envelope.playerId,
      roadsToPlace: freeRoadCount(state, envelope.playerId),
    }),
  );

const decidePlaceFreeRoad = (
  state: GameState,
  envelope: GameCommand,
  command: PlaceFreeRoadCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  if (state.phase.tag !== "turn.free-road") {
    return failure("wrong-command", "No free road placement is pending.");
  }
  if (!state.topology.edges.some(({ id }) => id === command.edgeId)) {
    return failure("unknown-location", "The road edge does not exist.");
  }
  if (state.occupancy.roads.some(({ edgeId }) => edgeId === command.edgeId)) {
    return failure("occupied-edge", "The road edge is occupied.");
  }
  if (playerRoadCount(state, envelope.playerId) >= 15) {
    return failure("piece-supply", "The player has no road piece available.");
  }
  if (!canBuildRoadAt(state, envelope.playerId, command.edgeId)) {
    return failure("disconnected-route", "The road must connect to the player's route.");
  }
  return Effect.succeed(
    actionEvent(state, envelope, {
      type: "free-road.placed" as const,
      playerId: envelope.playerId,
      edgeId: command.edgeId,
    }),
  );
};

const yearOfPlentyGrant = (
  bank: ResourceCounts,
  requested: readonly [Resource, Resource],
): ResourceCounts => {
  let grant = EMPTY_RESOURCES;
  let available = bank;
  for (const resource of requested) {
    if (available[resource] < 1) continue;
    const card = resourceAmount(resource, 1);
    grant = addResources(grant, card);
    available = subtractResources(available, card);
  }
  return grant;
};

const decidePlayYearOfPlenty = (
  state: GameState,
  envelope: GameCommand,
  command: PlayYearOfPlentyCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.map(requireDevelopmentCard(state, envelope.playerId, "year-of-plenty"), () =>
    actionEvent(state, envelope, {
      type: "year-of-plenty.played" as const,
      playerId: envelope.playerId,
      requested: command.resources,
      granted: yearOfPlentyGrant(state.bank, command.resources),
    }),
  );

const monopolyTransfers = (
  state: GameState,
  playerId: PlayerId,
  resource: Resource,
): ReadonlyArray<{ readonly playerId: PlayerId; readonly amount: number }> =>
  state.players
    .filter((player) => player.id !== playerId && player.resources[resource] > 0)
    .map((player) => ({ playerId: player.id, amount: player.resources[resource] }));

const decidePlayMonopoly = (
  state: GameState,
  envelope: GameCommand,
  command: PlayMonopolyCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
  Effect.map(requireDevelopmentCard(state, envelope.playerId, "monopoly"), () =>
    actionEvent(state, envelope, {
      type: "monopoly.played" as const,
      playerId: envelope.playerId,
      resource: command.resource,
      transfers: monopolyTransfers(state, envelope.playerId, command.resource),
    }),
  );

const decideSetupCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<EventBatch, RuleViolation> | undefined => {
  switch (command.command.type) {
    case "place-initial-settlement":
      return decideSettlement(state, command, command.command);
    case "place-initial-road":
      return decideInitialRoad(state, command, command.command);
    default:
      return undefined;
  }
};

const decideNormalCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<EventBatch, RuleViolation> | undefined => {
  switch (command.command.type) {
    case "roll-dice":
      return decideRollDice(state, command, command.command);
    case "build-road":
      return decideBuildRoad(state, command, command.command);
    case "build-settlement":
      return decideBuildSettlement(state, command, command.command);
    case "build-city":
      return decideBuildCity(state, command, command.command);
    case "buy-development-card":
      return decideBuyDevelopmentCard(state, command, command.command);
    case "maritime-trade":
      return decideMaritimeTrade(state, command, command.command);
    case "end-turn":
      return decideEndTurn(state, command, command.command);
    default:
      return undefined;
  }
};

const decideEffectCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<EventBatch, RuleViolation> => {
  switch (command.command.type) {
    case "discard-resource":
      return decideDiscardResource(state, command, command.command);
    case "move-robber":
      return decideMoveRobber(state, command, command.command);
    case "play-knight":
      return decidePlayKnight(state, command, command.command);
    case "play-road-building":
      return decidePlayRoadBuilding(state, command, command.command);
    case "place-free-road":
      return decidePlaceFreeRoad(state, command, command.command);
    case "play-year-of-plenty":
      return decidePlayYearOfPlenty(state, command, command.command);
    case "play-monopoly":
      return decidePlayMonopoly(state, command, command.command);
    default:
      return failure("wrong-command", "The command is not available in the current phase.");
  }
};

export const decide = (
  state: GameState,
  input: GameCommand,
): Effect.Effect<EventBatch, RuleViolation> =>
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
    const decision =
      decideSetupCommand(state, command) ??
      decideNormalCommand(state, command) ??
      decideEffectCommand(state, command);
    return yield* decision;
  });

export const handleCommand = (
  state: GameState,
  command: GameCommand,
): Effect.Effect<CommandResult, RuleViolation> =>
  Effect.map(decide(state, command), (events) => ({
    events,
    state: events.reduce((current, event) => applyEvent(current, event), state),
  }));

const makeAction = (
  state: GameState,
  playerId: PlayerId,
  id: string,
  command: GameCommand["command"],
): LegalAction => ({
  id,
  command: {
    schema: "catanarchy.command.v1",
    matchId: state.matchId,
    commandId: `action:${state.sequence + 1}:${id}`,
    playerId,
    expectedSequence: state.sequence,
    command,
  },
});

const legalInitialSettlementActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> =>
  state.topology.vertices
    .filter((vertex) => isSettlementLocationLegal(state, vertex.id))
    .map((vertex) =>
      makeAction(state, playerId, `settlement:${vertex.id}`, {
        type: "place-initial-settlement",
        vertexId: vertex.id,
      }),
    );

const legalInitialRoadActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> => {
  if (state.phase.tag !== "setup.road") return [];
  const settlementId = state.phase.settlementId;
  return state.topology.edges
    .filter(
      (edge) =>
        edge.vertexIds.includes(settlementId) &&
        !state.occupancy.roads.some((road) => road.edgeId === edge.id),
    )
    .map((edge) =>
      makeAction(state, playerId, `road:${edge.id}`, {
        type: "place-initial-road",
        edgeId: edge.id,
      }),
    );
};

const legalPaidRoadActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  if (playerRoadCount(state, playerId) >= 15) return [];
  if (!playerCanAfford(state, playerId, ROAD_COST)) return [];
  return state.topology.edges
    .filter((edge) => canBuildRoadAt(state, playerId, edge.id))
    .map((edge) =>
      makeAction(state, playerId, `build-road:${edge.id}`, {
        type: "build-road",
        edgeId: edge.id,
      }),
    );
};

const legalPaidSettlementActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> => {
  if (playerBuildingCount(state, playerId, "settlement") >= 5) return [];
  if (!playerCanAfford(state, playerId, SETTLEMENT_COST)) return [];
  return state.topology.vertices
    .filter((vertex) => canBuildSettlementAt(state, playerId, vertex.id))
    .map((vertex) =>
      makeAction(state, playerId, `build-settlement:${vertex.id}`, {
        type: "build-settlement",
        vertexId: vertex.id,
      }),
    );
};

const legalCityActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  if (playerBuildingCount(state, playerId, "city") >= 4) return [];
  if (!playerCanAfford(state, playerId, CITY_COST)) return [];
  return state.occupancy.buildings
    .filter((building) => building.playerId === playerId && building.kind === "settlement")
    .map((building) =>
      makeAction(state, playerId, `build-city:${building.vertexId}`, {
        type: "build-city",
        vertexId: building.vertexId,
      }),
    );
};

const legalDevelopmentCardActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> => {
  if (state.developmentDeck.length === 0) return [];
  if (!playerCanAfford(state, playerId, DEVELOPMENT_CARD_COST)) return [];
  return [makeAction(state, playerId, "buy-development-card", { type: "buy-development-card" })];
};

const legalBuildActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => [
  ...legalPaidRoadActions(state, playerId),
  ...legalPaidSettlementActions(state, playerId),
  ...legalCityActions(state, playerId),
  ...legalDevelopmentCardActions(state, playerId),
];

const legalMaritimeActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  const actions: LegalAction[] = [];
  for (const give of RESOURCE_KEYS) {
    for (const receive of RESOURCE_KEYS) {
      if (canMaritimeTrade(state, playerId, give, receive)) {
        actions.push(
          makeAction(state, playerId, `maritime:${give}:${receive}`, {
            type: "maritime-trade",
            give,
            receive,
          }),
        );
      }
    }
  }
  return actions;
};

const legalDiscardActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  const player = playerById(state, playerId);
  if (player === undefined) return [];
  return RESOURCE_KEYS.filter((resource) => player.resources[resource] > 0).map((resource, index) =>
    makeAction(state, playerId, `private-option:${state.sequence}:${index + 1}`, {
      type: "discard-resource",
      resource,
    }),
  );
};

const legalRobberActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> =>
  state.topology.hexes
    .filter(({ id }) => id !== state.layout.robberHexId)
    .flatMap((hex) => {
      const victims = robberVictims(state, hex.id, playerId);
      const choices: ReadonlyArray<PlayerId | null> = victims.length === 0 ? [null] : victims;
      return choices.map((victimPlayerId) =>
        makeAction(state, playerId, `move-robber:${hex.id}:${victimPlayerId ?? "none"}`, {
          type: "move-robber",
          hexId: hex.id,
          victimPlayerId,
        }),
      );
    });

const legalFreeRoadActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  if (playerRoadCount(state, playerId) >= 15) return [];
  return state.topology.edges
    .filter((edge) => canBuildRoadAt(state, playerId, edge.id))
    .map((edge) =>
      makeAction(state, playerId, `free-road:${edge.id}`, {
        type: "place-free-road",
        edgeId: edge.id,
      }),
    );
};

const legalYearOfPlentyActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> => {
  if (!canPlayDevelopmentCard(state, playerId, "year-of-plenty")) return [];
  const actions: LegalAction[] = [];
  for (let first = 0; first < RESOURCE_KEYS.length; first += 1) {
    for (let second = first; second < RESOURCE_KEYS.length; second += 1) {
      const resources = [RESOURCE_KEYS[first]!, RESOURCE_KEYS[second]!] as const;
      actions.push(
        makeAction(state, playerId, `play-year-of-plenty:${resources.join(":")}`, {
          type: "play-year-of-plenty",
          resources,
        }),
      );
    }
  }
  return actions;
};

const legalActionDevelopmentCards = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> => {
  const actions: LegalAction[] = [];
  if (canPlayDevelopmentCard(state, playerId, "knight")) {
    actions.push(makeAction(state, playerId, "play-knight", { type: "play-knight" }));
  }
  if (canPlayDevelopmentCard(state, playerId, "road-building")) {
    actions.push(makeAction(state, playerId, "play-road-building", { type: "play-road-building" }));
  }
  if (canPlayDevelopmentCard(state, playerId, "monopoly")) {
    for (const resource of RESOURCE_KEYS) {
      actions.push(
        makeAction(state, playerId, `play-monopoly:${resource}`, {
          type: "play-monopoly",
          resource,
        }),
      );
    }
  }
  actions.push(...legalYearOfPlentyActions(state, playerId));
  return actions;
};

const legalSetupActions = (
  state: GameState,
  playerId: PlayerId,
): ReadonlyArray<LegalAction> | undefined => {
  switch (state.phase.tag) {
    case "setup.settlement":
      return legalInitialSettlementActions(state, playerId);
    case "setup.road":
      return legalInitialRoadActions(state, playerId);
    case "setup.completing":
      return [];
    default:
      return undefined;
  }
};

const legalTurnActions = (state: GameState, playerId: PlayerId): ReadonlyArray<LegalAction> => {
  switch (state.phase.tag) {
    case "turn.discard":
      return legalDiscardActions(state, playerId);
    case "turn.robber":
      return [
        ...legalActionDevelopmentCards(state, playerId),
        ...legalRobberActions(state, playerId),
      ];
    case "turn.free-road":
      return legalFreeRoadActions(state, playerId);
    case "turn.roll":
      return [
        ...legalActionDevelopmentCards(state, playerId),
        makeAction(state, playerId, "roll", { type: "roll-dice" }),
      ];
    case "turn.action":
      return [
        ...legalBuildActions(state, playerId),
        ...legalMaritimeActions(state, playerId),
        ...legalActionDevelopmentCards(state, playerId),
        makeAction(state, playerId, "end-turn", { type: "end-turn" }),
      ];
    default:
      return [];
  }
};

export const legalActions = (state: GameState): ReadonlyArray<LegalAction> => {
  const playerId = currentPlayerId(state);
  if (playerId === null) return [];
  return legalSetupActions(state, playerId) ?? legalTurnActions(state, playerId);
};

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
    players: state.config.players.map((configured) => {
      const player = state.players.find(({ id }) => id === configured.id)!;
      const buildings = state.occupancy.buildings.filter(
        ({ playerId }) => playerId === configured.id,
      );
      return {
        id: configured.id,
        name: configured.name,
        color: configured.color,
        resourceCount: RESOURCE_KEYS.reduce(
          (total, resource) => total + player.resources[resource],
          0,
        ),
        developmentCardCount: player.developmentCards.length,
        settlements: buildings.filter(({ kind }) => kind === "settlement").length,
        cities: buildings.filter(({ kind }) => kind === "city").length,
        roads: state.occupancy.roads.filter(({ playerId }) => playerId === configured.id).length,
      };
    }),
    bank: state.bank,
    ownResources: ownPlayer?.resources ?? null,
    ownDevelopmentCards: ownPlayer?.developmentCards ?? null,
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

const setupCommandFromEvent = (state: GameState, envelope: GameEvent): GameCommand | undefined => {
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
      return undefined;
  }
};

const normalCommandFromEvent = (state: GameState, envelope: GameEvent): GameCommand | undefined => {
  const common = {
    schema: "catanarchy.command.v1" as const,
    matchId: envelope.matchId,
    commandId: envelope.commandId,
    expectedSequence: state.sequence,
  };
  switch (envelope.event.type) {
    case "dice.rolled":
      return { ...common, playerId: envelope.event.playerId, command: { type: "roll-dice" } };
    case "road.built":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "build-road", edgeId: envelope.event.edgeId },
      };
    case "settlement.built":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "build-settlement", vertexId: envelope.event.vertexId },
      };
    case "city.built":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "build-city", vertexId: envelope.event.vertexId },
      };
    case "development-card.bought":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "buy-development-card" },
      };
    case "maritime-trade.completed":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: {
          type: "maritime-trade",
          give: envelope.event.give,
          receive: envelope.event.receive,
        },
      };
    case "turn.ended":
      return { ...common, playerId: envelope.event.playerId, command: { type: "end-turn" } };
    default:
      return undefined;
  }
};

const effectCommandFromEvent = (state: GameState, envelope: GameEvent): GameCommand | undefined => {
  const common = {
    schema: "catanarchy.command.v1" as const,
    matchId: envelope.matchId,
    commandId: envelope.commandId,
    expectedSequence: state.sequence,
  };
  switch (envelope.event.type) {
    case "resource.discarded":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "discard-resource", resource: envelope.event.resource },
      };
    case "robber.moved":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: {
          type: "move-robber",
          hexId: envelope.event.toHexId,
          victimPlayerId: envelope.event.victimPlayerId,
        },
      };
    case "knight.played":
      return { ...common, playerId: envelope.event.playerId, command: { type: "play-knight" } };
    case "road-building.played":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "play-road-building" },
      };
    case "free-road.placed":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "place-free-road", edgeId: envelope.event.edgeId },
      };
    case "year-of-plenty.played":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "play-year-of-plenty", resources: envelope.event.requested },
      };
    case "monopoly.played":
      return {
        ...common,
        playerId: envelope.event.playerId,
        command: { type: "play-monopoly", resource: envelope.event.resource },
      };
    default:
      return undefined;
  }
};

const commandFromEvent = (state: GameState, envelope: GameEvent): GameCommand | null =>
  setupCommandFromEvent(state, envelope) ??
  normalCommandFromEvent(state, envelope) ??
  effectCommandFromEvent(state, envelope) ??
  null;

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
