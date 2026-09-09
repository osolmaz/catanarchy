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

export type DevelopmentCard =
  | "knight"
  | "road-building"
  | "year-of-plenty"
  | "monopoly"
  | "victory-point";

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
  readonly developmentCards: ReadonlyArray<DevelopmentCard>;
  readonly playedKnights: number;
}

export type SetupPhase =
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
      readonly turn: 1;
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
  readonly phase: SetupPhase;
  readonly random: {
    readonly board: RandomState;
    readonly developmentDeck: RandomState;
  };
}

export interface RandomState {
  readonly algorithm: "catanarchy-prng-v1";
  readonly value: number;
  readonly draws: number;
}

export interface GameCreatedEvent {
  readonly sequence: 0;
  readonly type: "game.created";
  readonly commandId: CommandId;
  readonly state: GameState;
}

export interface SettlementPlacedEvent {
  readonly sequence: number;
  readonly type: "settlement.placed";
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly vertexId: VertexId;
}

export interface InitialResourcesGrantedEvent {
  readonly sequence: number;
  readonly type: "initial-resources.granted";
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly resources: ResourceCounts;
}

export interface RoadPlacedEvent {
  readonly sequence: number;
  readonly type: "road.placed";
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly edgeId: EdgeId;
}

export interface InitialPlacementCompletedEvent {
  readonly sequence: number;
  readonly type: "initial-placement.completed";
  readonly commandId: CommandId;
}

export type GameEvent =
  | GameCreatedEvent
  | SettlementPlacedEvent
  | InitialResourcesGrantedEvent
  | RoadPlacedEvent
  | InitialPlacementCompletedEvent;

interface CommandBase {
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly expectedSequence: number;
}

export interface PlaceInitialSettlementCommand extends CommandBase {
  readonly type: "place-initial-settlement";
  readonly vertexId: VertexId;
}

export interface PlaceInitialRoadCommand extends CommandBase {
  readonly type: "place-initial-road";
  readonly edgeId: EdgeId;
}

export type GameCommand = PlaceInitialSettlementCommand | PlaceInitialRoadCommand;

const CommandBaseSchemaFields = {
  commandId: Schema.String,
  playerId: Schema.String,
  expectedSequence: Schema.Number,
};

export const GameCommandSchema = Schema.Union(
  Schema.Struct({
    ...CommandBaseSchemaFields,
    type: Schema.Literal("place-initial-settlement"),
    vertexId: Schema.String,
  }),
  Schema.Struct({
    ...CommandBaseSchemaFields,
    type: Schema.Literal("place-initial-road"),
    edgeId: Schema.String,
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
}

export interface GameObservation {
  readonly schema: "catanarchy.observation.v1";
  readonly matchId: string;
  readonly sequence: number;
  readonly topology: StandardTopology;
  readonly layout: BoardLayout;
  readonly occupancy: BoardOccupancy;
  readonly phase: SetupPhase;
  readonly activePlayerId: PlayerId | null;
  readonly players: ReadonlyArray<PlayerSummary>;
  readonly bank: ResourceCounts;
  readonly ownResources: ResourceCounts | null;
}

export type Viewer =
  | { readonly type: "public" }
  | { readonly type: "player"; readonly playerId: PlayerId };

export interface CommandResult {
  readonly state: GameState;
  readonly events: readonly [GameEvent, ...ReadonlyArray<GameEvent>];
}
