import { Schema } from "effect";

export const PlayerColorSchema = Schema.Literal("red", "blue", "white", "orange");
export type PlayerColor = Schema.Schema.Type<typeof PlayerColorSchema>;

export const PlayerConfigSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  color: PlayerColorSchema,
});
export type PlayerConfig = Schema.Schema.Type<typeof PlayerConfigSchema>;

export const GameConfigSchema = Schema.Struct({
  schema: Schema.Literal("catanarchy.game-config.v1"),
  seed: Schema.Number,
  players: Schema.Array(PlayerConfigSchema),
});
export type GameConfig = Schema.Schema.Type<typeof GameConfigSchema>;

export const decodeGameConfig = Schema.decodeUnknown(GameConfigSchema);

export type GamePhase = "initial-placement-forward";

export interface GameCreatedEvent {
  readonly sequence: 0;
  readonly type: "game.created";
  readonly seed: number;
  readonly players: ReadonlyArray<Pick<PlayerConfig, "id" | "color">>;
}

export interface InitialPlacementStartedEvent {
  readonly sequence: 1;
  readonly type: "initial-placement.started";
  readonly activePlayerId: string;
  readonly direction: "forward";
}

export type GameEvent = GameCreatedEvent | InitialPlacementStartedEvent;
