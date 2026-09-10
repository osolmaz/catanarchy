import { Schema } from "effect";

export const PLAYER_COLORS = ["red", "blue", "white", "orange"] as const;
export const RESOURCE_TYPES = ["lumber", "brick", "wool", "grain", "ore"] as const;
export const TERRAIN_TYPES = ["forest", "hill", "pasture", "field", "mountain", "desert"] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number];
export type Resource = (typeof RESOURCE_TYPES)[number];
export type Terrain = (typeof TERRAIN_TYPES)[number];
export type HexId = `h:${number}:${number}`;
export type VertexId = `v:${number}:${number}`;
export type EdgeId = `e:${VertexId}|${VertexId}`;
export type PlayerId = string;
export type CommandId = string;

export const PlayerColorSchema = Schema.Literal(...PLAYER_COLORS);
export const ResourceSchema = Schema.Literal(...RESOURCE_TYPES);
export const PlayerConfigSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  color: PlayerColorSchema,
});
export type PlayerConfig = Schema.Schema.Type<typeof PlayerConfigSchema>;

export const GameConfigSchema = Schema.Struct({
  schema: Schema.Literal("catanarchy.game-config.v1"),
  matchId: Schema.String.pipe(Schema.minLength(1)),
  seed: Schema.Number,
  players: Schema.Array(PlayerConfigSchema),
});
export type GameConfig = Schema.Schema.Type<typeof GameConfigSchema>;
export const decodeGameConfig = Schema.decodeUnknown(GameConfigSchema);

export interface AxialCoordinate {
  readonly q: number;
  readonly r: number;
}

export interface VertexCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface TopologyHex extends AxialCoordinate {
  readonly id: HexId;
  readonly vertexIds: readonly [VertexId, VertexId, VertexId, VertexId, VertexId, VertexId];
  readonly edgeIds: readonly [EdgeId, EdgeId, EdgeId, EdgeId, EdgeId, EdgeId];
  readonly neighborHexIds: ReadonlyArray<HexId>;
}

export interface TopologyVertex extends VertexCoordinate {
  readonly id: VertexId;
  readonly adjacentHexIds: ReadonlyArray<HexId>;
  readonly adjacentVertexIds: ReadonlyArray<VertexId>;
  readonly edgeIds: ReadonlyArray<EdgeId>;
}

export interface TopologyEdge {
  readonly id: EdgeId;
  readonly vertexIds: readonly [VertexId, VertexId];
  readonly adjacentHexIds: ReadonlyArray<HexId>;
}

export interface StandardTopology {
  readonly schema: "catanarchy.standard-topology.v1";
  readonly hexes: ReadonlyArray<TopologyHex>;
  readonly vertices: ReadonlyArray<TopologyVertex>;
  readonly edges: ReadonlyArray<TopologyEdge>;
  readonly coastalRing: ReadonlyArray<EdgeId>;
}

export type NumberToken = 2 | 3 | 4 | 5 | 6 | 8 | 9 | 10 | 11 | 12;
export type HarborKind = "generic" | Resource;

export interface TerrainPlacement {
  readonly hexId: HexId;
  readonly terrain: Terrain;
}

export interface NumberPlacement {
  readonly hexId: HexId;
  readonly number: NumberToken;
}

export interface HarborPlacement {
  readonly edgeId: EdgeId;
  readonly kind: HarborKind;
}

export interface BoardLayout {
  readonly topology: "standard-radius-2";
  readonly terrain: ReadonlyArray<TerrainPlacement>;
  readonly numbers: ReadonlyArray<NumberPlacement>;
  readonly harbors: ReadonlyArray<HarborPlacement>;
  readonly robberHexId: HexId;
}

export interface ResourceCounts {
  readonly lumber: number;
  readonly brick: number;
  readonly wool: number;
  readonly grain: number;
  readonly ore: number;
}

export const ResourceCountsSchema = Schema.Struct({
  lumber: Schema.Number,
  brick: Schema.Number,
  wool: Schema.Number,
  grain: Schema.Number,
  ore: Schema.Number,
});

export const DEVELOPMENT_CARDS = [
  "knight",
  "road-building",
  "year-of-plenty",
  "monopoly",
  "victory-point",
] as const;
export type DevelopmentCard = (typeof DEVELOPMENT_CARDS)[number];
export type DevelopmentDiscardCard = Exclude<DevelopmentCard, "knight" | "victory-point">;
export const DevelopmentCardSchema = Schema.Literal(...DEVELOPMENT_CARDS);

export interface OwnedDevelopmentCard {
  readonly card: DevelopmentCard;
  readonly purchasedTurn: number;
}

export interface Building {
  readonly vertexId: VertexId;
  readonly playerId: PlayerId;
  readonly kind: "settlement" | "city";
}

export interface Road {
  readonly edgeId: EdgeId;
  readonly playerId: PlayerId;
}

export interface BoardOccupancy {
  readonly buildings: ReadonlyArray<Building>;
  readonly roads: ReadonlyArray<Road>;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly resources: ResourceCounts;
  readonly developmentCards: ReadonlyArray<OwnedDevelopmentCard>;
  readonly playedKnights: number;
}

export interface AwardState {
  readonly longestRoadPlayerId: PlayerId | null;
  readonly largestArmyPlayerId: PlayerId | null;
}

export interface GameResult {
  readonly winnerId: PlayerId;
  readonly turn: number;
  readonly victoryPoints: number;
  readonly revealedVictoryPointCards: number;
}

export type TurnContinuation =
  | { readonly tag: "turn.roll" }
  | { readonly tag: "turn.action"; readonly dice: readonly [number, number] }
  | {
      readonly tag: "turn.robber";
      readonly source: "roll" | "knight";
      readonly continuation: TurnContinuation;
    };

export type GamePhase =
  | {
      readonly tag: "setup.settlement";
      readonly direction: "forward" | "reverse";
      readonly playerIndex: number;
    }
  | {
      readonly tag: "setup.road";
      readonly direction: "forward" | "reverse";
      readonly playerIndex: number;
      readonly settlementId: VertexId;
    }
  | {
      readonly tag: "setup.completing";
      readonly playerIndex: 0;
    }
  | {
      readonly tag: "turn.roll";
      readonly playerIndex: number;
      readonly turn: number;
      readonly developmentCardPlayed: boolean;
    }
  | {
      readonly tag: "turn.action";
      readonly playerIndex: number;
      readonly turn: number;
      readonly dice: readonly [number, number];
      readonly developmentCardPlayed: boolean;
    }
  | {
      readonly tag: "turn.discard";
      readonly playerIndex: number;
      readonly rollerIndex: number;
      readonly turn: number;
      readonly dice: readonly [number, number];
      readonly remaining: number;
      readonly queue: ReadonlyArray<{ readonly playerIndex: number; readonly remaining: number }>;
      readonly developmentCardPlayed: boolean;
    }
  | {
      readonly tag: "turn.robber";
      readonly playerIndex: number;
      readonly turn: number;
      readonly source: "roll" | "knight";
      readonly continuation: TurnContinuation;
      readonly developmentCardPlayed: boolean;
    }
  | {
      readonly tag: "turn.free-road";
      readonly playerIndex: number;
      readonly turn: number;
      readonly remaining: 1 | 2;
      readonly continuation: TurnContinuation;
      readonly developmentCardPlayed: true;
    }
  | {
      readonly tag: "game.finished";
      readonly playerIndex: number;
      readonly turn: number;
    };

export interface GameState {
  readonly schema: "catanarchy.game-state.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly config: GameConfig;
  readonly topology: StandardTopology;
  readonly layout: BoardLayout;
  readonly occupancy: BoardOccupancy;
  readonly bank: ResourceCounts;
  readonly players: ReadonlyArray<PlayerState>;
  readonly developmentDeck: ReadonlyArray<DevelopmentCard>;
  readonly developmentDiscard: ReadonlyArray<DevelopmentDiscardCard>;
  readonly awards: AwardState;
  readonly result: GameResult | null;
  readonly phase: GamePhase;
  readonly random: {
    readonly board: RandomState;
    readonly developmentDeck: RandomState;
    readonly dice: RandomState;
    readonly resourceSteal: RandomState;
  };
}

export interface RandomState {
  readonly algorithm: "catanarchy-prng-v1";
  readonly value: number;
  readonly draws: number;
}

export const RandomStateSchema = Schema.Struct({
  algorithm: Schema.Literal("catanarchy-prng-v1"),
  value: Schema.Number,
  draws: Schema.Number,
});

export interface GameCreatedEvent {
  readonly type: "game.created";
  readonly state: GameState;
}

export interface SettlementPlacedEvent {
  readonly type: "settlement.placed";
  readonly playerId: PlayerId;
  readonly vertexId: VertexId;
}

export interface InitialResourcesGrantedEvent {
  readonly type: "initial-resources.granted";
  readonly playerId: PlayerId;
  readonly resources: ResourceCounts;
}

export interface RoadPlacedEvent {
  readonly type: "road.placed";
  readonly playerId: PlayerId;
  readonly edgeId: EdgeId;
}

export interface InitialPlacementCompletedEvent {
  readonly type: "initial-placement.completed";
}

export interface ResourceGrant {
  readonly playerId: PlayerId;
  readonly resources: ResourceCounts;
}

export interface DiceRolledEvent {
  readonly type: "dice.rolled";
  readonly playerId: PlayerId;
  readonly dice: readonly [number, number];
  readonly nextRandom: RandomState;
  readonly grants: ReadonlyArray<ResourceGrant>;
  readonly shortages: ReadonlyArray<Resource>;
}

export interface RoadBuiltEvent {
  readonly type: "road.built";
  readonly playerId: PlayerId;
  readonly edgeId: EdgeId;
}

export interface SettlementBuiltEvent {
  readonly type: "settlement.built";
  readonly playerId: PlayerId;
  readonly vertexId: VertexId;
}

export interface CityBuiltEvent {
  readonly type: "city.built";
  readonly playerId: PlayerId;
  readonly vertexId: VertexId;
}

export interface DevelopmentCardBoughtEvent {
  readonly type: "development-card.bought";
  readonly playerId: PlayerId;
  readonly card: DevelopmentCard;
  readonly purchasedTurn: number;
}

export interface MaritimeTradeCompletedEvent {
  readonly type: "maritime-trade.completed";
  readonly playerId: PlayerId;
  readonly give: Resource;
  readonly receive: Resource;
  readonly rate: 2 | 3 | 4;
}

export interface DomesticTradeCompletedEvent {
  readonly type: "domestic-trade.completed";
  readonly playerId: PlayerId;
  readonly partnerPlayerId: PlayerId;
  readonly give: ResourceCounts;
  readonly receive: ResourceCounts;
}

export interface TurnEndedEvent {
  readonly type: "turn.ended";
  readonly playerId: PlayerId;
  readonly nextPlayerIndex: number;
  readonly nextTurn: number;
}

export interface ResourceDiscardedEvent {
  readonly type: "resource.discarded";
  readonly playerId: PlayerId;
  readonly resource: Resource;
}

export interface RobberMovedEvent {
  readonly type: "robber.moved";
  readonly playerId: PlayerId;
  readonly fromHexId: HexId;
  readonly toHexId: HexId;
  readonly victimPlayerId: PlayerId | null;
  readonly stolenResource: Resource | null;
  readonly nextRandom: RandomState;
}

export interface KnightPlayedEvent {
  readonly type: "knight.played";
  readonly playerId: PlayerId;
}

export interface RoadBuildingPlayedEvent {
  readonly type: "road-building.played";
  readonly playerId: PlayerId;
  readonly roadsToPlace: 0 | 1 | 2;
}

export interface FreeRoadPlacedEvent {
  readonly type: "free-road.placed";
  readonly playerId: PlayerId;
  readonly edgeId: EdgeId;
}

export interface YearOfPlentyPlayedEvent {
  readonly type: "year-of-plenty.played";
  readonly playerId: PlayerId;
  readonly requested: readonly [Resource, Resource];
  readonly granted: ResourceCounts;
}

export interface MonopolyTransfer {
  readonly playerId: PlayerId;
  readonly amount: number;
}

export interface MonopolyPlayedEvent {
  readonly type: "monopoly.played";
  readonly playerId: PlayerId;
  readonly resource: Resource;
  readonly transfers: ReadonlyArray<MonopolyTransfer>;
}

export interface LongestRoadChangedEvent {
  readonly type: "longest-road.changed";
  readonly previousPlayerId: PlayerId | null;
  readonly playerId: PlayerId | null;
  readonly length: number;
}

export interface LargestArmyChangedEvent {
  readonly type: "largest-army.changed";
  readonly previousPlayerId: PlayerId | null;
  readonly playerId: PlayerId | null;
  readonly size: number;
}

export interface GameWonEvent {
  readonly type: "game.won";
  readonly playerId: PlayerId;
  readonly playerIndex: number;
  readonly turn: number;
  readonly victoryPoints: number;
  readonly revealedVictoryPointCards: number;
}

export interface EventEnvelope<TEvent> {
  readonly schema: "catanarchy.game-event.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly commandId: CommandId;
  readonly event: TEvent;
}

export type GameEvent =
  | EventEnvelope<GameCreatedEvent>
  | EventEnvelope<SettlementPlacedEvent>
  | EventEnvelope<InitialResourcesGrantedEvent>
  | EventEnvelope<RoadPlacedEvent>
  | EventEnvelope<InitialPlacementCompletedEvent>
  | EventEnvelope<DiceRolledEvent>
  | EventEnvelope<RoadBuiltEvent>
  | EventEnvelope<SettlementBuiltEvent>
  | EventEnvelope<CityBuiltEvent>
  | EventEnvelope<DevelopmentCardBoughtEvent>
  | EventEnvelope<MaritimeTradeCompletedEvent>
  | EventEnvelope<DomesticTradeCompletedEvent>
  | EventEnvelope<TurnEndedEvent>
  | EventEnvelope<ResourceDiscardedEvent>
  | EventEnvelope<RobberMovedEvent>
  | EventEnvelope<KnightPlayedEvent>
  | EventEnvelope<RoadBuildingPlayedEvent>
  | EventEnvelope<FreeRoadPlacedEvent>
  | EventEnvelope<YearOfPlentyPlayedEvent>
  | EventEnvelope<MonopolyPlayedEvent>
  | EventEnvelope<LongestRoadChangedEvent>
  | EventEnvelope<LargestArmyChangedEvent>
  | EventEnvelope<GameWonEvent>;

const EventEnvelopeSchemaFields = {
  schema: Schema.Literal("catanarchy.game-event.v1"),
  matchId: Schema.String.pipe(Schema.minLength(1)),
  sequence: Schema.Number,
  commandId: Schema.String.pipe(Schema.minLength(1)),
};

export const GameEventEnvelopeSchema = Schema.Union(
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("game.created"),
      state: Schema.Struct({ config: GameConfigSchema }),
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("settlement.placed"),
      playerId: Schema.String,
      vertexId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("initial-resources.granted"),
      playerId: Schema.String,
      resources: ResourceCountsSchema,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("road.placed"),
      playerId: Schema.String,
      edgeId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({ type: Schema.Literal("initial-placement.completed") }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("dice.rolled"),
      playerId: Schema.String,
      dice: Schema.Tuple(Schema.Number, Schema.Number),
      nextRandom: RandomStateSchema,
      grants: Schema.Array(
        Schema.Struct({ playerId: Schema.String, resources: ResourceCountsSchema }),
      ),
      shortages: Schema.Array(ResourceSchema),
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("road.built"),
      playerId: Schema.String,
      edgeId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("settlement.built"),
      playerId: Schema.String,
      vertexId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("city.built"),
      playerId: Schema.String,
      vertexId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("development-card.bought"),
      playerId: Schema.String,
      card: DevelopmentCardSchema,
      purchasedTurn: Schema.Number,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("maritime-trade.completed"),
      playerId: Schema.String,
      give: ResourceSchema,
      receive: ResourceSchema,
      rate: Schema.Literal(2, 3, 4),
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("domestic-trade.completed"),
      playerId: Schema.String,
      partnerPlayerId: Schema.String,
      give: ResourceCountsSchema,
      receive: ResourceCountsSchema,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("turn.ended"),
      playerId: Schema.String,
      nextPlayerIndex: Schema.Number,
      nextTurn: Schema.Number,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("resource.discarded"),
      playerId: Schema.String,
      resource: ResourceSchema,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("robber.moved"),
      playerId: Schema.String,
      fromHexId: Schema.String,
      toHexId: Schema.String,
      victimPlayerId: Schema.NullOr(Schema.String),
      stolenResource: Schema.NullOr(ResourceSchema),
      nextRandom: RandomStateSchema,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({ type: Schema.Literal("knight.played"), playerId: Schema.String }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("road-building.played"),
      playerId: Schema.String,
      roadsToPlace: Schema.Literal(0, 1, 2),
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("free-road.placed"),
      playerId: Schema.String,
      edgeId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("year-of-plenty.played"),
      playerId: Schema.String,
      requested: Schema.Tuple(ResourceSchema, ResourceSchema),
      granted: ResourceCountsSchema,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("monopoly.played"),
      playerId: Schema.String,
      resource: ResourceSchema,
      transfers: Schema.Array(Schema.Struct({ playerId: Schema.String, amount: Schema.Number })),
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("longest-road.changed"),
      previousPlayerId: Schema.NullOr(Schema.String),
      playerId: Schema.NullOr(Schema.String),
      length: Schema.Number,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("largest-army.changed"),
      previousPlayerId: Schema.NullOr(Schema.String),
      playerId: Schema.NullOr(Schema.String),
      size: Schema.Number,
    }),
  }),
  Schema.Struct({
    ...EventEnvelopeSchemaFields,
    event: Schema.Struct({
      type: Schema.Literal("game.won"),
      playerId: Schema.String,
      playerIndex: Schema.Number,
      turn: Schema.Number,
      victoryPoints: Schema.Number,
      revealedVictoryPointCards: Schema.Number,
    }),
  }),
);
export const decodeGameEventEnvelope = Schema.decodeUnknown(GameEventEnvelopeSchema);

export interface PlaceInitialSettlementCommand {
  readonly type: "place-initial-settlement";
  readonly vertexId: VertexId;
}

export interface PlaceInitialRoadCommand {
  readonly type: "place-initial-road";
  readonly edgeId: EdgeId;
}

export interface RollDiceCommand {
  readonly type: "roll-dice";
}

export interface BuildRoadCommand {
  readonly type: "build-road";
  readonly edgeId: EdgeId;
}

export interface BuildSettlementCommand {
  readonly type: "build-settlement";
  readonly vertexId: VertexId;
}

export interface BuildCityCommand {
  readonly type: "build-city";
  readonly vertexId: VertexId;
}

export interface BuyDevelopmentCardCommand {
  readonly type: "buy-development-card";
}

export interface MaritimeTradeCommand {
  readonly type: "maritime-trade";
  readonly give: Resource;
  readonly receive: Resource;
}

export interface DomesticTradeCommand {
  readonly type: "domestic-trade";
  readonly partnerPlayerId: PlayerId;
  readonly give: ResourceCounts;
  readonly receive: ResourceCounts;
}

export interface EndTurnCommand {
  readonly type: "end-turn";
}

export interface DiscardResourceCommand {
  readonly type: "discard-resource";
  readonly resource: Resource;
}

export interface MoveRobberCommand {
  readonly type: "move-robber";
  readonly hexId: HexId;
  readonly victimPlayerId: PlayerId | null;
}

export interface PlayKnightCommand {
  readonly type: "play-knight";
}

export interface PlayRoadBuildingCommand {
  readonly type: "play-road-building";
}

export interface PlaceFreeRoadCommand {
  readonly type: "place-free-road";
  readonly edgeId: EdgeId;
}

export interface PlayYearOfPlentyCommand {
  readonly type: "play-year-of-plenty";
  readonly resources: readonly [Resource, Resource];
}

export interface PlayMonopolyCommand {
  readonly type: "play-monopoly";
  readonly resource: Resource;
}

export type GameCommandPayload =
  | PlaceInitialSettlementCommand
  | PlaceInitialRoadCommand
  | RollDiceCommand
  | BuildRoadCommand
  | BuildSettlementCommand
  | BuildCityCommand
  | BuyDevelopmentCardCommand
  | MaritimeTradeCommand
  | DomesticTradeCommand
  | EndTurnCommand
  | DiscardResourceCommand
  | MoveRobberCommand
  | PlayKnightCommand
  | PlayRoadBuildingCommand
  | PlaceFreeRoadCommand
  | PlayYearOfPlentyCommand
  | PlayMonopolyCommand;

export interface GameCommand {
  readonly schema: "catanarchy.command.v1";
  readonly matchId: string;
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly expectedSequence: number;
  readonly command: GameCommandPayload;
}

const CommandEnvelopeSchemaFields = {
  schema: Schema.Literal("catanarchy.command.v1"),
  matchId: Schema.String.pipe(Schema.minLength(1)),
  commandId: Schema.String.pipe(Schema.minLength(1)),
  playerId: Schema.String.pipe(Schema.minLength(1)),
  expectedSequence: Schema.Number,
};

export const GameCommandSchema = Schema.Union(
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("place-initial-settlement"),
      vertexId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("place-initial-road"),
      edgeId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("roll-dice") }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("build-road"), edgeId: Schema.String }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("build-settlement"),
      vertexId: Schema.String,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("build-city"), vertexId: Schema.String }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("buy-development-card") }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("maritime-trade"),
      give: ResourceSchema,
      receive: ResourceSchema,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("domestic-trade"),
      partnerPlayerId: Schema.String,
      give: ResourceCountsSchema,
      receive: ResourceCountsSchema,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("end-turn") }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("discard-resource"),
      resource: ResourceSchema,
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("move-robber"),
      hexId: Schema.String,
      victimPlayerId: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("play-knight") }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("play-road-building") }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({ type: Schema.Literal("place-free-road"), edgeId: Schema.String }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("play-year-of-plenty"),
      resources: Schema.Tuple(ResourceSchema, ResourceSchema),
    }),
  }),
  Schema.Struct({
    ...CommandEnvelopeSchemaFields,
    command: Schema.Struct({
      type: Schema.Literal("play-monopoly"),
      resource: ResourceSchema,
    }),
  }),
);
export const decodeGameCommand = Schema.decodeUnknown(GameCommandSchema);

export interface LegalAction {
  readonly id: string;
  readonly command: GameCommand;
}

export interface PlayerSummary {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: PlayerColor;
  readonly resourceCount: number;
  readonly developmentCardCount: number;
  readonly settlements: number;
  readonly cities: number;
  readonly roads: number;
  readonly longestRoadLength: number;
  readonly playedKnights: number;
  readonly hasLongestRoad: boolean;
  readonly hasLargestArmy: boolean;
  readonly visibleVictoryPoints: number;
}

export interface GameObservation {
  readonly schema: "catanarchy.observation.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly topology: StandardTopology;
  readonly layout: BoardLayout;
  readonly occupancy: BoardOccupancy;
  readonly phase: GamePhase;
  readonly activePlayerId: PlayerId | null;
  readonly players: ReadonlyArray<PlayerSummary>;
  readonly bank: ResourceCounts;
  readonly awards: AwardState;
  readonly result: GameResult | null;
  readonly ownResources: ResourceCounts | null;
  readonly ownDevelopmentCards: ReadonlyArray<OwnedDevelopmentCard> | null;
  readonly ownVictoryPoints: number | null;
}

export type Viewer =
  | { readonly type: "public" }
  | { readonly type: "player"; readonly playerId: PlayerId };

export type NegotiationScope =
  | { readonly type: "public" }
  | { readonly type: "direct"; readonly playerId: PlayerId };

export type TradeOfferStatus =
  | "open"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "countered"
  | "expired"
  | "failed";

export interface TradeOffer {
  readonly id: string;
  readonly parentOfferId: string | null;
  readonly round: number;
  readonly gameSequence: number;
  readonly proposerPlayerId: PlayerId;
  readonly targetPlayerId: PlayerId;
  readonly scope: NegotiationScope;
  readonly give: ResourceCounts;
  readonly receive: ResourceCounts;
  readonly status: TradeOfferStatus;
}

export interface NegotiationPromise {
  readonly id: string;
  readonly round: number;
  readonly playerId: PlayerId;
  readonly beneficiaryPlayerId: PlayerId;
  readonly scope: NegotiationScope;
  readonly text: string;
  readonly relatedOfferId: string | null;
}

export interface PromiseEvidence {
  readonly id: string;
  readonly round: number;
  readonly playerId: PlayerId;
  readonly promiseId: string;
  readonly gameSequence: number;
  readonly text: string;
}

export type NegotiationAction =
  | { readonly type: "pass" }
  | { readonly type: "send-message"; readonly scope: NegotiationScope; readonly text: string }
  | {
      readonly type: "make-offer";
      readonly targetPlayerId: PlayerId;
      readonly scope: NegotiationScope;
      readonly give: ResourceCounts;
      readonly receive: ResourceCounts;
    }
  | {
      readonly type: "counter-offer";
      readonly offerId: string;
      readonly scope: NegotiationScope;
      readonly give: ResourceCounts;
      readonly receive: ResourceCounts;
    }
  | { readonly type: "accept-offer"; readonly offerId: string }
  | { readonly type: "reject-offer"; readonly offerId: string }
  | { readonly type: "withdraw-offer"; readonly offerId: string }
  | {
      readonly type: "record-promise";
      readonly beneficiaryPlayerId: PlayerId;
      readonly scope: NegotiationScope;
      readonly text: string;
      readonly relatedOfferId: string | null;
    }
  | {
      readonly type: "record-promise-evidence";
      readonly promiseId: string;
      readonly gameSequence: number;
      readonly text: string;
    };

const NegotiationScopeSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("public") }),
  Schema.Struct({ type: Schema.Literal("direct"), playerId: Schema.String }),
);

export const NegotiationActionSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("pass") }),
  Schema.Struct({
    type: Schema.Literal("send-message"),
    scope: NegotiationScopeSchema,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("make-offer"),
    targetPlayerId: Schema.String,
    scope: NegotiationScopeSchema,
    give: ResourceCountsSchema,
    receive: ResourceCountsSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("counter-offer"),
    offerId: Schema.String,
    scope: NegotiationScopeSchema,
    give: ResourceCountsSchema,
    receive: ResourceCountsSchema,
  }),
  Schema.Struct({ type: Schema.Literal("accept-offer"), offerId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reject-offer"), offerId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("withdraw-offer"), offerId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("record-promise"),
    beneficiaryPlayerId: Schema.String,
    scope: NegotiationScopeSchema,
    text: Schema.String,
    relatedOfferId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("record-promise-evidence"),
    promiseId: Schema.String,
    gameSequence: Schema.Number,
    text: Schema.String,
  }),
);
export const decodeNegotiationAction = Schema.decodeUnknown(NegotiationActionSchema);

export type NegotiationWindowCloseReason = "all-passed" | "round-limit" | "game-ended";

export type NegotiationEventPayload =
  | {
      readonly type: "negotiation.window-opened";
      readonly windowId: string;
      readonly turn: number;
      readonly turnPlayerId: PlayerId;
      readonly maxRounds: number;
    }
  | {
      readonly type: "negotiation.message-sent";
      readonly round: number;
      readonly playerId: PlayerId;
      readonly scope: NegotiationScope;
      readonly text: string;
    }
  | {
      readonly type: "negotiation.player-passed";
      readonly round: number;
      readonly playerId: PlayerId;
    }
  | { readonly type: "trade.offer-created"; readonly offer: TradeOffer }
  | {
      readonly type: "trade.offer-closed";
      readonly offerId: string;
      readonly playerId: PlayerId | null;
      readonly status: Exclude<TradeOfferStatus, "open" | "accepted" | "failed">;
    }
  | {
      readonly type: "trade.offer-accepted";
      readonly offerId: string;
      readonly playerId: PlayerId;
      readonly gameEventSequence: number;
    }
  | {
      readonly type: "trade.offer-failed";
      readonly offerId: string;
      readonly playerId: PlayerId;
      readonly reason: "invalid" | "stale";
    }
  | { readonly type: "negotiation.promise-recorded"; readonly promise: NegotiationPromise }
  | { readonly type: "negotiation.promise-evidence-recorded"; readonly evidence: PromiseEvidence }
  | {
      readonly type: "negotiation.window-closed";
      readonly windowId: string;
      readonly reason: NegotiationWindowCloseReason;
    };

export interface NegotiationEvent {
  readonly schema: "catanarchy.negotiation-event.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly gameSequence: number;
  readonly event: NegotiationEventPayload;
}

const TradeOfferSchema = Schema.Struct({
  id: Schema.String,
  parentOfferId: Schema.NullOr(Schema.String),
  round: Schema.Number,
  gameSequence: Schema.Number,
  proposerPlayerId: Schema.String,
  targetPlayerId: Schema.String,
  scope: NegotiationScopeSchema,
  give: ResourceCountsSchema,
  receive: ResourceCountsSchema,
  status: Schema.Union(
    Schema.Literal("open"),
    Schema.Literal("accepted"),
    Schema.Literal("rejected"),
    Schema.Literal("withdrawn"),
    Schema.Literal("countered"),
    Schema.Literal("expired"),
    Schema.Literal("failed"),
  ),
});

const NegotiationPromiseSchema = Schema.Struct({
  id: Schema.String,
  round: Schema.Number,
  playerId: Schema.String,
  beneficiaryPlayerId: Schema.String,
  scope: NegotiationScopeSchema,
  text: Schema.String,
  relatedOfferId: Schema.NullOr(Schema.String),
});

const PromiseEvidenceSchema = Schema.Struct({
  id: Schema.String,
  round: Schema.Number,
  playerId: Schema.String,
  promiseId: Schema.String,
  gameSequence: Schema.Number,
  text: Schema.String,
});

const NegotiationEventPayloadSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("negotiation.window-opened"),
    windowId: Schema.String,
    turn: Schema.Number,
    turnPlayerId: Schema.String,
    maxRounds: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("negotiation.message-sent"),
    round: Schema.Number,
    playerId: Schema.String,
    scope: NegotiationScopeSchema,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("negotiation.player-passed"),
    round: Schema.Number,
    playerId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("trade.offer-created"), offer: TradeOfferSchema }),
  Schema.Struct({
    type: Schema.Literal("trade.offer-closed"),
    offerId: Schema.String,
    playerId: Schema.NullOr(Schema.String),
    status: Schema.Union(
      Schema.Literal("rejected"),
      Schema.Literal("withdrawn"),
      Schema.Literal("countered"),
      Schema.Literal("expired"),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("trade.offer-accepted"),
    offerId: Schema.String,
    playerId: Schema.String,
    gameEventSequence: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("trade.offer-failed"),
    offerId: Schema.String,
    playerId: Schema.String,
    reason: Schema.Union(Schema.Literal("invalid"), Schema.Literal("stale")),
  }),
  Schema.Struct({
    type: Schema.Literal("negotiation.promise-recorded"),
    promise: NegotiationPromiseSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("negotiation.promise-evidence-recorded"),
    evidence: PromiseEvidenceSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("negotiation.window-closed"),
    windowId: Schema.String,
    reason: Schema.Union(
      Schema.Literal("all-passed"),
      Schema.Literal("round-limit"),
      Schema.Literal("game-ended"),
    ),
  }),
);

export const NegotiationEventSchema = Schema.Struct({
  schema: Schema.Literal("catanarchy.negotiation-event.v1"),
  matchId: Schema.String.pipe(Schema.minLength(1)),
  sequence: Schema.Number,
  gameSequence: Schema.Number,
  event: NegotiationEventPayloadSchema,
});
export const decodeNegotiationEvent = Schema.decodeUnknown(NegotiationEventSchema);

export interface NegotiationView {
  readonly schema: "catanarchy.negotiation-view.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly events: ReadonlyArray<NegotiationEvent>;
  readonly offers: ReadonlyArray<TradeOffer>;
  readonly promises: ReadonlyArray<NegotiationPromise>;
  readonly evidence: ReadonlyArray<PromiseEvidence>;
}

export interface CommandResult {
  readonly state: GameState;
  readonly events: readonly [GameEvent, ...ReadonlyArray<GameEvent>];
}
