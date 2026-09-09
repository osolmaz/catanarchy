export { createGame } from "./engine/game.js";
export type { GameState } from "./engine/game.js";
export { RuleViolation } from "./engine/errors.js";
export type { RuleViolationCode } from "./engine/errors.js";
export { nextUint32, randomUnit, rollDice } from "./engine/random.js";
export type { DiceRoll, RandomResult, RandomState } from "./engine/random.js";
export {
  decodeGameConfig,
  GameConfigSchema,
  PlayerColorSchema,
  PlayerConfigSchema,
} from "./protocol/model.js";
export type {
  GameConfig,
  GameCreatedEvent,
  GameEvent,
  GamePhase,
  InitialPlacementStartedEvent,
  PlayerColor,
  PlayerConfig,
} from "./protocol/model.js";
