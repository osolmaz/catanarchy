import { Effect } from "effect";
import type { GameConfig, GameEvent, GamePhase, PlayerConfig } from "../protocol/model.js";
import { RuleViolation } from "./errors.js";
import type { RandomState } from "./random.js";

export interface GameState {
  readonly schema: "catanarchy.game-state.v1";
  readonly seed: number;
  readonly random: RandomState;
  readonly players: ReadonlyArray<PlayerConfig>;
  readonly activePlayerIndex: number;
  readonly phase: GamePhase;
  readonly turn: 0;
  readonly events: ReadonlyArray<GameEvent>;
}

const hasDuplicates = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size !== values.length;

const validateConfig = (config: GameConfig): Effect.Effect<void, RuleViolation> => {
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) {
    return Effect.fail(
      new RuleViolation({
        code: "invalid-seed",
        message: "The seed must be an unsigned 32-bit integer.",
      }),
    );
  }

  if (config.players.length < 3 || config.players.length > 4) {
    return Effect.fail(
      new RuleViolation({
        code: "invalid-player-count",
        message: "A base game needs three or four players.",
      }),
    );
  }

  if (hasDuplicates(config.players.map(({ id }) => id))) {
    return Effect.fail(
      new RuleViolation({
        code: "duplicate-player-id",
        message: "Each player must have a unique ID.",
      }),
    );
  }

  if (hasDuplicates(config.players.map(({ color }) => color))) {
    return Effect.fail(
      new RuleViolation({
        code: "duplicate-player-color",
        message: "Each player must have a unique color.",
      }),
    );
  }

  return Effect.void;
};

export const createGame = (config: GameConfig): Effect.Effect<GameState, RuleViolation> =>
  Effect.gen(function* () {
    yield* validateConfig(config);

    const firstPlayer = config.players[0];
    if (firstPlayer === undefined) {
      return yield* Effect.fail(
        new RuleViolation({
          code: "invalid-player-count",
          message: "A base game needs three or four players.",
        }),
      );
    }

    const events: ReadonlyArray<GameEvent> = [
      {
        sequence: 0,
        type: "game.created",
        seed: config.seed,
        players: config.players.map(({ id, color }) => ({ id, color })),
      },
      {
        sequence: 1,
        type: "initial-placement.started",
        activePlayerId: firstPlayer.id,
        direction: "forward",
      },
    ];

    return {
      schema: "catanarchy.game-state.v1",
      seed: config.seed,
      random: { value: config.seed >>> 0 },
      players: config.players,
      activePlayerIndex: 0,
      phase: "initial-placement-forward",
      turn: 0,
      events,
    };
  });
